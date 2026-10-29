import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskWatchersPanel } from "./TaskWatchersPanel";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.request }));
const endpoint = "/api/tasks/task/messages/watchers";
const candidates = { users: [{ id: "person", name: "Анна", departmentName: "Колл-центр" }], groups: [{ id: "group", name: "Техподдержка", memberCount: 3 }] };
const clients: QueryClient[] = [];
function mount(actorId = "actor", onChanged = vi.fn(), expanded = true) {
 const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });clients.push(client);
 const tree = (actor = actorId) => <QueryClientProvider client={client}><TaskWatchersPanel taskId="task" projectId="project" actorId={actor} onChanged={onChanged} /></QueryClientProvider>;
 const view = render(tree());
 if (expanded) fireEvent.click(screen.getByRole("heading", {name:"Наблюдатели"}).closest("summary")!);
 return { ...view, client, onChanged, rerenderActor: (actor: string) => view.rerender(tree(actor)) };
}
beforeEach(() => {mocks.request.mockReset().mockImplementation(async (url: string, options?: RequestInit) => options?.method ? {added:2} : url.includes("view=candidates") ? candidates : {items:[{userId:"existing",name:"Иван"}],canManage:true});});
afterEach(() => {cleanup();clients.splice(0).forEach(client=>client.clear());vi.useRealTimers();});

it("starts collapsed with the real count and keeps picker input and selection across toggles",async()=>{
 mount("actor",vi.fn(),false);
 const summary=screen.getByRole("heading",{name:"Наблюдатели"}).closest("summary")!;
 expect(summary.parentElement).not.toHaveAttribute("open");
 expect(await screen.findByLabelText("Доступных наблюдателей: 1")).toBeVisible();
 expect(screen.getByText("Иван")).not.toBeVisible();
 fireEvent.click(summary);
 expect(screen.getByText("Иван")).toBeVisible();
 fireEvent.click(screen.getByRole("button",{name:"Добавить наблюдателей"}));
 fireEvent.click(await screen.findByRole("checkbox",{name:/Анна/}));
 fireEvent.change(screen.getByRole("textbox",{name:"Найти сотрудников или группы"}),{target:{value:"Анна"}});
 fireEvent.click(screen.getByRole("button",{name:"Отмена"}));
 fireEvent.click(summary);
 expect(summary.parentElement).not.toHaveAttribute("open");
 fireEvent.click(summary);
 fireEvent.click(screen.getByRole("button",{name:"Добавить наблюдателей"}));
 expect(screen.getByRole("textbox",{name:"Найти сотрудников или группы"})).toHaveValue("Анна");
 expect(await screen.findByRole("checkbox",{name:/Анна/})).toBeChecked();
 expect(mocks.request.mock.calls.some(([,options])=>options?.method)).toBe(false);
});

it("keeps loading and read errors distinct from a confirmed empty count",async()=>{
 let reject!:(error:Error)=>void;
 mocks.request.mockImplementation(()=>new Promise((_resolve,fail)=>{reject=fail;}));
 mount("actor",vi.fn(),false);
 const summary=screen.getByRole("heading",{name:"Наблюдатели"}).closest("summary")!;
 expect(summary).toHaveTextContent("Загрузка…");
 expect(screen.queryByLabelText(/Доступных наблюдателей/)).not.toBeInTheDocument();
 await act(async()=>reject(new Error("private read failure")));
 expect(await screen.findByText("Не удалось загрузить")).toBeVisible();
 expect(screen.queryByLabelText(/Доступных наблюдателей/)).not.toBeInTheDocument();
 fireEvent.click(summary);
 mocks.request.mockResolvedValue({items:[],canManage:false});
 fireEvent.click(screen.getByRole("button",{name:"Повторить загрузку наблюдателей"}));
 expect(await screen.findByLabelText("Доступных наблюдателей: 0")).toHaveTextContent("0");
 expect(screen.queryByText("private read failure")).not.toBeInTheDocument();
});

it("updates the compact count after a confirmed removal and refresh",async()=>{
 let removed=false;
 mocks.request.mockImplementation(async(_url:string,options?:RequestInit)=>{
  if(options?.method==="DELETE"){removed=true;return {};}
  return {items:removed?[]:[{userId:"existing",name:"Иван"}],canManage:true};
 });
 mount();
 expect(await screen.findByLabelText("Доступных наблюдателей: 1")).toBeVisible();
 fireEvent.click(screen.getByRole("button",{name:"Убрать наблюдателя Иван"}));
 expect(await screen.findByLabelText("Доступных наблюдателей: 0")).toBeVisible();
 expect(screen.getByText("Наблюдателей пока нет.")).toBeVisible();
});

it("shows server-authorized watchers, legacy name fallback and no management for an ordinary reader",async()=>{
 mocks.request.mockResolvedValue({items:[{userId:"legacy"}],canManage:false});mount();
 expect(await screen.findByText("Сотрудник")).toBeVisible();
 expect(screen.getByText("Видят обращение и могут найти его в поиске. Не становятся исполнителями.")).toBeVisible();
 expect(screen.queryByRole("button",{name:"Добавить наблюдателей"})).not.toBeInTheDocument();
 expect(screen.queryByRole("button",{name:/Убрать наблюдателя/})).not.toBeInTheDocument();
});
it("adds people and groups atomically, explains the group snapshot and refreshes the parent version",async()=>{
 const view=mount();fireEvent.click(await screen.findByRole("button",{name:"Добавить наблюдателей"}));
 const dialog=await screen.findByRole("dialog",{name:"Добавить наблюдателей"});
 expect(within(dialog).getByRole("button",{name:"Добавить выбранных"})).toBeDisabled();
 fireEvent.click(await within(dialog).findByRole("checkbox",{name:/Анна/}));
 fireEvent.mouseDown(within(dialog).getByRole("tab",{name:"Группы"}),{button:0,ctrlKey:false});
 fireEvent.click(within(dialog).getByRole("checkbox",{name:/Техподдержка/}));
 expect(within(dialog).getByText("Добавятся текущие сотрудники группы. Новые участники автоматически доступ не получат.")).toBeVisible();
 fireEvent.click(within(dialog).getByRole("button",{name:"Добавить выбранных"}));
 await screen.findByText("Добавлено наблюдателей: 2.");
 const call=mocks.request.mock.calls.find(([,options])=>options?.method==="POST")!;
 expect(call[0]).toBe(endpoint);expect(JSON.parse(call[1].body)).toEqual({userIds:["person"],groupIds:["group"]});
 expect(view.onChanged).toHaveBeenCalledOnce();
 expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
 expect(mocks.request.mock.calls.filter(([url])=>url===endpoint)).toHaveLength(3);
});
it("retains selections on failure and blocks duplicate submits until the request settles",async()=>{
 let reject!: (reason: Error)=>void;const pending=new Promise((_,fail)=>{reject=fail;});
 mocks.request.mockImplementation(async(url:string,options?:RequestInit)=>options?.method==="POST"?pending:url.includes("view=candidates")?candidates:{items:[],canManage:true});
 mount();fireEvent.click(await screen.findByRole("button",{name:"Добавить наблюдателей"}));
 fireEvent.click(await screen.findByRole("checkbox",{name:/Анна/}));fireEvent.click(screen.getByRole("button",{name:"Добавить выбранных"}));
 const saving=screen.getByRole("button",{name:"Сохраняем…"});expect(saving).toBeDisabled();fireEvent.click(saving);
 expect(mocks.request.mock.calls.filter(([,options])=>options?.method==="POST")).toHaveLength(1);
 await act(async()=>reject(new Error("private response")));
 expect(await screen.findByRole("alert")).toHaveTextContent("Выбор сохранён");
 expect(screen.getByRole("checkbox",{name:/Анна/})).toBeChecked();
 expect(screen.getByRole("button",{name:"Добавить выбранных"})).toBeEnabled();
 expect(screen.queryByText("private response")).not.toBeInTheDocument();
});
it("removes exactly the named watcher and reloads current details",async()=>{
 const view=mount();fireEvent.click(await screen.findByRole("button",{name:"Убрать наблюдателя Иван"}));await screen.findByText("Наблюдатель убран.");
 const call=mocks.request.mock.calls.find(([,options])=>options?.method==="DELETE")!;expect(JSON.parse(call[1].body)).toEqual({userId:"existing"});expect(view.onChanged).toHaveBeenCalledOnce();
});
it("uses debounced server search with AbortSignal and hides stale candidates while typing",async()=>{
 mount();fireEvent.click(await screen.findByRole("button",{name:"Добавить наблюдателей"}));await screen.findByRole("checkbox",{name:/Анна/});
 vi.useFakeTimers();fireEvent.change(screen.getByRole("textbox",{name:"Найти сотрудников или группы"}),{target:{value:"новый"}});
 expect(screen.queryByRole("checkbox",{name:/Анна/})).not.toBeInTheDocument();
 await act(async()=>{vi.advanceTimersByTime(199);});expect(mocks.request.mock.calls.some(([url])=>url.includes("search=%D0%BD"))).toBe(false);
 await act(async()=>{vi.advanceTimersByTime(1);});
 expect(mocks.request).toHaveBeenCalledWith(`${endpoint}?view=candidates&search=${encodeURIComponent("новый")}`,expect.objectContaining({signal:expect.any(AbortSignal),cache:"no-store"}));
 vi.useRealTimers();
});
it("drops a former actor's selection and cached names until the new actor is authorized",async()=>{
 const view=mount();fireEvent.click(await screen.findByRole("button",{name:"Добавить наблюдателей"}));fireEvent.click(await screen.findByRole("checkbox",{name:/Анна/}));
 let resolve!: (value:unknown)=>void;mocks.request.mockImplementation(()=>new Promise(done=>{resolve=done;}));
 view.rerenderActor("new-actor");expect(screen.queryByRole("dialog")).not.toBeInTheDocument();expect(screen.queryByText("Иван")).not.toBeInTheDocument();
 await act(async()=>resolve({items:[],canManage:false}));
 expect(screen.queryByRole("button",{name:"Добавить наблюдателей"})).not.toBeInTheDocument();expect(view.client.getQueryCache().findAll({queryKey:["task-watchers","actor","task"]})).toHaveLength(0);
});
it("shows a retryable load error without revealing cached management controls",async()=>{
 mocks.request.mockRejectedValue(new Error("synthetic secret"));mount();expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить наблюдателей.");
 expect(screen.queryByRole("button",{name:"Добавить наблюдателей"})).not.toBeInTheDocument();mocks.request.mockResolvedValue({items:[],canManage:false});fireEvent.click(screen.getByRole("button",{name:"Повторить загрузку наблюдателей"}));expect(await screen.findByText("Наблюдателей пока нет.")).toBeVisible();
});

it("does not show warm cached watcher names or manager actions before a fresh server answer",async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(client);
 client.setQueryData(["task-watchers","actor","task"],{items:[{userId:"old",name:"Старое имя"}],canManage:true});
 let resolve!:(value:unknown)=>void;mocks.request.mockImplementation(()=>new Promise(done=>{resolve=done;}));
 render(<QueryClientProvider client={client}><TaskWatchersPanel taskId="task" projectId="project" actorId="actor" /></QueryClientProvider>);
 fireEvent.click(screen.getByRole("heading",{name:"Наблюдатели"}).closest("summary")!);
 expect(screen.queryByText("Старое имя")).not.toBeInTheDocument();
 expect(screen.queryByRole("button",{name:"Добавить наблюдателей"})).not.toBeInTheDocument();
 expect(screen.getByRole("status")).toHaveTextContent("Загрузка наблюдателей");
 await act(async()=>resolve({items:[{userId:"reader",name:"Актуальный читатель"}],canManage:false}));
 expect(await screen.findByText("Актуальный читатель")).toBeVisible();
 expect(screen.queryByRole("button",{name:"Добавить наблюдателей"})).not.toBeInTheDocument();
});


it("keeps people and group selections while switching the accessible picker tabs",async()=>{
 mount();fireEvent.click(await screen.findByRole("button",{name:"Добавить наблюдателей"}));
 const person=await screen.findByRole("checkbox",{name:/Анна/});
 expect(screen.getByRole("tab",{name:"Сотрудники"})).toHaveAttribute("aria-selected","true");
 expect(screen.queryByRole("checkbox",{name:/Техподдержка/})).not.toBeInTheDocument();
 fireEvent.click(person);
 fireEvent.mouseDown(screen.getByRole("tab",{name:"Группы"}),{button:0,ctrlKey:false});
 expect(screen.queryByRole("checkbox",{name:/Анна/})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole("checkbox",{name:/Техподдержка/}));
 fireEvent.mouseDown(screen.getByRole("tab",{name:"Сотрудники"}),{button:0,ctrlKey:false});
 expect(screen.getByRole("checkbox",{name:/Анна/})).toBeChecked();
 fireEvent.mouseDown(screen.getByRole("tab",{name:"Группы"}),{button:0,ctrlKey:false});
 expect(screen.getByRole("checkbox",{name:/Техподдержка/})).toBeChecked();
 expect(screen.getByText("Выбрано сотрудников: 1, групп: 1.")).toBeVisible();
});
