import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicantDirection } from "./ApplicantDirection";
import { RequestActionsContext } from "@/components/task/RequestQuickTake";
import { encodeRequestDescription } from "@/lib/request-presentation";
import type { TaskType } from "@/components/kanban/Card";

// Keep ApplicantDirection, common header, RequestBoardPresentation, Card and API
// parsing real. Only session/navigation/dialog and the HTTP boundary are isolated.
const boundary = vi.hoisted(() => ({ actor: "applicant-one", status: "authenticated", open: vi.fn(), push: vi.fn(), socket: vi.fn(), fetch: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: boundary.actor ? { user: { id: boundary.actor } } : null, status: boundary.status }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: boundary.push, replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/departments/beznal", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/task/RequestDialogProvider", () => ({ useRequestDialog: () => boundary.open }));
vi.mock("@/lib/socket-client", () => ({ getSocketInstance: boundary.socket }));
vi.mock("@/components/task/CreateTaskDialog", () => ({ CreateTaskDialog: ({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) => open ? <div role="dialog" aria-label="Существующая форма" data-project-id={projectId}><button onClick={onClose}>Вернуться</button></div> : null }));

let client: QueryClient;
let rows: TaskType[];
let responseStatus: number;
let countStatus: number;
let actorCounts: Record<string,number>;
function urlOf(input:string|Request|URL){return new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url,"http://localhost");}
function taskResponse(data:TaskType[],page=1){return new Response(JSON.stringify({success:true,data,meta:{page,limit:500,hasMore:false}}),{status:200,headers:{"Content-Type":"application/json"}});}
function countResponse(){const count=actorCounts[boundary.actor]??0;return new Response(JSON.stringify(countStatus===200?{success:true,data:{byProject:{bank:count},total:count}}:{success:false,error:{code:"UNAVAILABLE",message:"Недоступно"}}),{status:countStatus,headers:{"Content-Type":"application/json"}});}
function notificationResponse(){return Response.json({success:true,data:{actorId:boundary.actor,count:0,byProject:{},byTask:{},unscopedCount:0}});}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const row = (id: string, state: string, category: string, priority = "LOW"): TaskType => ({
  id, title: id, projectId: "bank", priority, position: 0, version: 1,
  description: encodeRequestDescription("Доступное описание", { kind: "beznal", category, company: "ООО «Синтетика»", amount: "125 000" }),
  request: { state, executorId: state === "SUBMITTED" ? null : "accountant", author: { id: "applicant-one", name: "Автор" } },
});
beforeEach(() => {
  boundary.actor = "applicant-one"; boundary.status = "authenticated";
  boundary.open.mockReset(); boundary.push.mockReset(); boundary.socket.mockReset(); boundary.fetch.mockReset();
  rows = []; responseStatus = 200; countStatus = 200; actorCounts = {"applicant-one":0,"applicant-two":0};
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  boundary.fetch.mockImplementation(async (input: string | Request | URL) => {
    const url = urlOf(input);
    if(url.pathname==="/api/tasks/queue-unseen")return countResponse();
    if(url.pathname==="/api/notifications/unread-count")return notificationResponse();
    if(url.pathname==="/api/tasks/changes")return Response.json({success:true,data:{actorId:boundary.actor,byTask:{}}});
    if (url.pathname !== "/api/tasks") throw new Error(`Unexpected protected metadata request: ${url.pathname}`);
    return new Response(JSON.stringify(responseStatus === 200 ? { success: true, data: rows, meta: { page: Number(url.searchParams.get("page") || 1), limit: 500, hasMore: false } } : { success: false, error: { code: "DENIED", message: "Недоступно" } }), { status: responseStatus, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", boundary.fetch);
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

function tree() {
  return <QueryClientProvider client={client}><RequestActionsContext.Provider value={true}><ApplicantDirection projectId="bank" projectName="Безнал ОП" /></RequestActionsContext.Provider></QueryClientProvider>;
}
function assertNoProtectedCapabilities() {
  for (const call of boundary.fetch.mock.calls) {
    const input = call[0] as string | URL | Request;
    const url = urlOf(input);
    expect(["/api/tasks","/api/tasks/queue-unseen","/api/tasks/changes","/api/notifications/unread-count"]).toContain(url.pathname);
    if(url.pathname==="/api/tasks"||url.pathname==="/api/tasks/changes")expect(url.searchParams.get("projectId")).toBe("bank");
    else expect(url.search).toBe("");
    expect((call[1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  }
  expect(boundary.socket).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Взять в работу|Передать|Назначить|Удалить|Экспорт|Настройки|Участники/ })).not.toBeInTheDocument();
}
async function refreshOnFocus() {
  await act(async () => { window.dispatchEvent(new Event("focus")); });
}

describe("applicant common board: independent scope and revocation acceptance", () => {
  it("renders the real common empty two-stage board, metrics and filters without protected metadata or execution", async () => {
    render(tree());
    await waitFor(() => expect(boundary.fetch).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: "Безнал ОП", level: 1 })).toBeVisible();
    expect(await screen.findByLabelText("Сводка обращений")).toBeVisible();
    expect(screen.getByRole("button", { name: "Добавить обращение" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Текущие обращения" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Архив/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Список" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Доска" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Поиск обращений" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Фильтр срочности" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Категория" })).toBeVisible();
    const columns = screen.getByRole("region", { name: "Колонки обращений" });
    for (const name of ["Ждут обработки", "Со счётом"]) expect(within(columns).getByRole("region", { name })).toBeVisible();
    expect(within(columns).getAllByText("Здесь пока нет обращений")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /^Архив/ }));
    fireEvent.click(screen.getByRole("button", { name: "Список" }));
    expect(screen.getByText("В архиве пока нет обращений.")).toBeVisible();
    assertNoProtectedCapabilities();
  });

  it("uses authorized rows for filters/archive and opens existing dialogs without inheriting executor context", async () => {
    rows = [row("Мой срочный счёт", "SUBMITTED", "Счёт", "URGENT"), row("Моё уточнение", "NEEDS_INFO", "Платёж"), row("Мой закрытый платёж", "CLOSED", "Платёж"),row("Чужой черновик","DRAFT","Скрытая категория")];
    render(tree());
    const title = await screen.findByRole("button", { name: "Открыть обращение «Мой срочный счёт»" });
    expect(screen.queryByText("Чужой черновик")).not.toBeInTheDocument();
    expect(screen.queryByRole("option",{name:"Скрытая категория"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Взять в работу/ })).not.toBeInTheDocument();
    fireEvent.click(title);
    expect(boundary.open).toHaveBeenCalledWith({ projectId: "bank", taskId: "Мой срочный счёт" }, title);
    fireEvent.change(screen.getByRole("textbox", { name: "Поиск обращений" }), { target: { value: "уточнение" } });
    expect(screen.getByRole("button", { name: "Открыть обращение «Моё уточнение»" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Открыть обращение «Мой срочный счёт»" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    fireEvent.click(screen.getByRole("button", { name: "Срочные" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Категория" }), { target: { value: "Счёт" } });
    expect(screen.getByRole("button", { name: "Открыть обращение «Мой срочный счёт»" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Открыть обращение «Моё уточнение»" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    fireEvent.click(screen.getByRole("button", { name: /^Архив/ }));
    expect(screen.getByRole("button", { name: "Открыть обращение «Мой закрытый платёж»" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Открыть обращение «Мой срочный счёт»" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Добавить обращение" }));
    expect(await screen.findByRole("dialog", { name: "Существующая форма" })).toHaveAttribute("data-project-id", "bank");
    assertNoProtectedCapabilities();
  });

  it.each([401, 403, 404])("removes previously cached row and category after a fresh %s refusal", async status => {
    rows = [row("Ранее доступная заявка", "SUBMITTED", "Скрываемая категория")];
    render(tree());
    expect(await screen.findByRole("button", { name: "Открыть обращение «Ранее доступная заявка»" })).toBeVisible();
    const previousRequests = boundary.fetch.mock.calls.length;
    responseStatus = status;
    await refreshOnFocus();
    await waitFor(() => expect(boundary.fetch.mock.calls.length).toBeGreaterThan(previousRequests));
    await waitFor(() => expect(screen.queryByText("Ранее доступная заявка")).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(/Не удалось загрузить/);
    expect(screen.queryByRole("option", { name: "Скрываемая категория" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"Добавить обращение"})).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog",{name:"Существующая форма"})).not.toBeInTheDocument();
    assertNoProtectedCapabilities();
  });

  it("does not reuse a previous actor's rows while the next actor's server read is pending", async () => {
    rows = [{...row("Заявка первого пользователя", "SUBMITTED", "Первый пользователь","URGENT"),queueArrival:{epoch:1,unseen:true}}];
    actorCounts["applicant-one"]=7;
    const mounted = render(tree());
    expect(await screen.findByRole("button", { name: "Открыть обращение «Заявка первого пользователя»" })).toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:"Список"}));
    fireEvent.change(screen.getByRole("textbox",{name:"Поиск обращений"}),{target:{value:"первого"}});
    fireEvent.click(screen.getByRole("button",{name:"Срочные"}));
    fireEvent.click(await screen.findByRole("button",{name:"Новые в очереди · 7"}));
    expect(await screen.findByRole("button",{name:"Открыть обращение «Заявка первого пользователя»"})).toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:"Добавить обращение"}));
    expect(await screen.findByRole("dialog",{name:"Существующая форма"})).toBeVisible();
    const pending=deferred<Response>();
    boundary.actor = "applicant-two";
    boundary.fetch.mockImplementation((input:string|Request|URL)=>{
      const path=urlOf(input).pathname;
      if(path==="/api/tasks/queue-unseen")return Promise.resolve(countResponse());
      if(path==="/api/notifications/unread-count")return Promise.resolve(notificationResponse());
      return pending.promise;
    });
    mounted.rerender(tree());
    expect(screen.queryByText("Заявка первого пользователя")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Первый пользователь" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog",{name:"Существующая форма"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"Новые в очереди · 7"})).not.toBeInTheDocument();
    await act(async()=>{pending.resolve(taskResponse([]));});
    expect(await screen.findByRole("button",{name:"Доска"})).toHaveAttribute("aria-pressed","true");
    expect(screen.getByRole("textbox",{name:"Поиск обращений"})).toHaveValue("");
    expect(screen.getByRole("button",{name:"Срочные"})).toHaveAttribute("aria-pressed","false");
    expect(await screen.findByRole("button",{name:"Новые в очереди · 0"})).toHaveAttribute("aria-pressed","false");
    expect(client.getQueryCache().find({queryKey:["tasks","bank","applicant","applicant-two",false],exact:true})).toBeDefined();
    expect(client.getQueryCache().find({queryKey:["request-queue-unseen","applicant-two"],exact:true})).toBeDefined();
    expect(boundary.socket).not.toHaveBeenCalled();
    assertNoProtectedCapabilities();
  });
  it("drops old dialogs, count and rows after logout and does not issue authenticated reads",async()=>{
    rows=[row("Заявка до выхода","SUBMITTED","Старая категория")];actorCounts["applicant-one"]=4;
    const mounted=render(tree());
    expect(await screen.findByRole("button",{name:"Открыть обращение «Заявка до выхода»"})).toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:"Добавить обращение"}));
    expect(await screen.findByRole("dialog",{name:"Существующая форма"})).toBeVisible();
    const before=boundary.fetch.mock.calls.length;boundary.actor="";boundary.status="unauthenticated";
    mounted.rerender(tree());
    expect(await screen.findByRole("alert")).toHaveTextContent("Войдите заново");
    expect(screen.queryByText("Заявка до выхода")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog",{name:"Существующая форма"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:/Новые в очереди/})).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"Добавить обращение"})).not.toBeInTheDocument();
    await refreshOnFocus();expect(boundary.fetch).toHaveBeenCalledTimes(before);
    assertNoProtectedCapabilities();
  });
  it("does not render a previous actor's late reply after changing accounts",async()=>{
    rows=[row("Первоначальная заявка","SUBMITTED","Первая категория")];
    const mounted=render(tree());
    expect(await screen.findByRole("button",{name:"Открыть обращение «Первоначальная заявка»"})).toBeVisible();
    const oldReply=deferred<Response>();let oldSignal:AbortSignal|undefined;
    boundary.fetch.mockImplementation((input:string|Request|URL,options?:RequestInit)=>{
      if(urlOf(input).pathname==="/api/tasks/queue-unseen")return Promise.resolve(countResponse());
      if(urlOf(input).pathname==="/api/notifications/unread-count")return Promise.resolve(notificationResponse());
      if(boundary.actor==="applicant-one"){oldSignal=options?.signal??undefined;return oldReply.promise;}
      return Promise.resolve(taskResponse([row("Заявка второго пользователя","SUBMITTED","Вторая категория")]));
    });
    await refreshOnFocus();await waitFor(()=>expect(oldSignal).toBeDefined());
    boundary.actor="applicant-two";mounted.rerender(tree());
    expect(await screen.findByRole("button",{name:"Открыть обращение «Заявка второго пользователя»"})).toBeVisible();
    expect(oldSignal?.aborted).toBe(true);
    await act(async()=>{oldReply.resolve(taskResponse([row("Запоздавший ответ первого","SUBMITTED","Секретная старая категория")]));});
    expect(screen.queryByText("Первоначальная заявка")).not.toBeInTheDocument();
    expect(screen.queryByText("Запоздавший ответ первого")).not.toBeInTheDocument();
    expect(screen.queryByRole("option",{name:"Секретная старая категория"})).not.toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Открыть обращение «Заявка второго пользователя»"})).toBeVisible();
    assertNoProtectedCapabilities();
  });
});
