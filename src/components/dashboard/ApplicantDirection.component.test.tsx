import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {TaskType} from "@/components/kanban/Card";
import {ApplicantDirection} from "./ApplicantDirection";
const mocks=vi.hoisted(()=>({read:vi.fn(),tasks:vi.fn(),counts:vi.fn(),open:vi.fn(),push:vi.fn()}));
vi.mock("@/lib/api",()=>({apiFetch:mocks.read}));
vi.mock("next-auth/react",()=>({useSession:()=>({status:"authenticated",data:{user:{id:"applicant-one"}}})}));
vi.mock("next/navigation",()=>({useRouter:()=>({push:mocks.push})}));
vi.mock("@/components/task/RequestDialogProvider",()=>({useRequestDialog:()=>mocks.open}));
vi.mock("@/components/task/CreateTaskDialog",()=>({CreateTaskDialog:({projectId,onClose}:{projectId:string;onClose:()=>void})=><div data-testid="applicant-form" data-board={projectId}><button onClick={onClose}>Вернуться</button></div>}));
let client:QueryClient;
const row=(id:string,patch:Partial<TaskType>={}):TaskType=>({id,projectId:"bank",title:id,priority:"LOW",position:0,version:1,request:{state:"SUBMITTED",executorId:null},...patch});
const unseenRow=(id:string,priority="LOW")=>row(id,{priority,queueArrival:{epoch:1,unseen:true}});
const parsed=(value:string)=>new URL(value,"http://localhost");
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function mount(initiallyOpen=false){return render(<QueryClientProvider client={client}><ApplicantDirection projectId="bank" projectName="Безнал ОП" initiallyOpen={initiallyOpen}/></QueryClientProvider>);}
beforeEach(()=>{
 vi.clearAllMocks();client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 mocks.tasks.mockReset().mockResolvedValue([]);mocks.counts.mockReset().mockResolvedValue({byProject:{bank:0},total:0});
 // Keep count-object and task-array HTTP contracts separate.
 mocks.read.mockImplementation((path:string,options:unknown)=>{
  if(path==="/api/tasks/queue-unseen")return mocks.counts(path,options);
  if(path==="/api/notifications/unread-count")return Promise.resolve({actorId:"applicant-one",count:0,byProject:{},byTask:{},unscopedCount:0});
  if(parsed(path).pathname==="/api/tasks/changes")return Promise.resolve({actorId:"applicant-one",byTask:{}});
  if(parsed(path).pathname==="/api/tasks")return mocks.tasks(path,options);
  throw new Error("Unexpected metadata request");
 });
});
afterEach(()=>{cleanup();client.clear();});
it("opens the existing form from the common department header and restores it after closing",async()=>{
 mount();expect(await screen.findByRole("button",{name:"Доска"})).toHaveAttribute("aria-pressed","true");
 fireEvent.click(screen.getByRole("button",{name:"Добавить обращение"}));
 expect(await screen.findByTestId("applicant-form")).toHaveAttribute("data-board","bank");
 fireEvent.click(screen.getByRole("button",{name:"Вернуться"}));expect(screen.queryByTestId("applicant-form")).not.toBeInTheDocument();
 expect(screen.getByLabelText("Сводка обращений")).toBeInTheDocument();
});
it("preserves explicit create intent with the same authorized existing form",async()=>{
 mount(true);expect(await screen.findByTestId("applicant-form")).toHaveAttribute("data-board","bank");
 expect(await screen.findByRole("region",{name:"Колонки обращений"})).toBeInTheDocument();
});
it("reads every page before rendering and deduplicates overlapping IDs",async()=>{
 mocks.tasks.mockResolvedValueOnce(Array.from({length:500},()=>row("Первая заявка"))).mockResolvedValueOnce([row("Первая заявка"),row("Последняя заявка")]);
 mount();
 expect(await screen.findByRole("button",{name:"Открыть обращение «Последняя заявка»"})).toBeInTheDocument();
 expect(screen.getAllByRole("button",{name:"Открыть обращение «Первая заявка»"})).toHaveLength(1);
 expect(mocks.tasks.mock.calls.map(call=>call[0])).toEqual(["/api/tasks?projectId=bank&page=1&limit=500","/api/tasks?projectId=bank&page=2&limit=500"]);
 expect(mocks.tasks.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
 expect(mocks.counts).toHaveBeenCalled();
});
it("checks one empty page when the last real page has exactly the API maximum",async()=>{
 mocks.tasks.mockResolvedValueOnce(Array.from({length:500},()=>row("Полная страница"))).mockResolvedValueOnce([]);
 mount();expect(await screen.findByRole("button",{name:"Открыть обращение «Полная страница»"})).toBeInTheDocument();expect(mocks.tasks).toHaveBeenCalledTimes(2);
});
it.each([429,503])("does not render a partial list after page two fails with %s",async status=>{
 mocks.tasks.mockResolvedValueOnce(Array.from({length:500},()=>row("Нельзя показывать неполный список"))).mockRejectedValueOnce(Object.assign(new Error("safe failure"),{status}));
 mount();expect(await screen.findByRole("alert")).toHaveTextContent(/Не удалось загрузить/);
 expect(screen.queryByText("Нельзя показывать неполный список")).not.toBeInTheDocument();
 expect(screen.getByLabelText("Сводка обращений")).toHaveTextContent("—");
 expect(screen.queryByRole("button",{name:"Добавить обращение"})).not.toBeInTheDocument();
 expect(screen.queryByTestId("applicant-form")).not.toBeInTheDocument();
 expect(screen.queryByText("По выбранным фильтрам обращений нет. Попробуйте сбросить фильтры.")).not.toBeInTheDocument();
});
it("fails closed at the explicit resource bound instead of claiming a complete 5000-row board",async()=>{
 mocks.tasks.mockResolvedValue(Array.from({length:500},()=>row("Неполная заявка")));
 mount();expect(await screen.findByRole("alert")).toBeInTheDocument();expect(mocks.tasks).toHaveBeenCalledTimes(10);expect(screen.queryByText("Неполная заявка")).not.toBeInTheDocument();
});
it("refetches all actor-scoped pages after the existing task mutation invalidation",async()=>{
 mocks.tasks.mockResolvedValueOnce([row("До изменения")]).mockResolvedValueOnce([row("После изменения")]);mount();
 expect(await screen.findByRole("button",{name:"Открыть обращение «До изменения»"})).toBeInTheDocument();
 await act(async()=>{await client.invalidateQueries({queryKey:["tasks","bank"]});});
 expect(await screen.findByRole("button",{name:"Открыть обращение «После изменения»"})).toBeInTheDocument();expect(screen.queryByText("До изменения")).not.toBeInTheDocument();
});
it("cancels the scoped read when leaving the board",async()=>{
 mocks.tasks.mockImplementation(()=>new Promise(()=>{}));const mounted=mount();await waitFor(()=>expect(mocks.tasks).toHaveBeenCalled());
 const signal=mocks.tasks.mock.calls[0][1].signal as AbortSignal;mounted.unmount();expect(signal.aborted).toBe(true);
});
it("keeps defensive draft exclusion while rendering authorized submitted rows",async()=>{
 mocks.tasks.mockResolvedValue([row("Скрытый черновик",{request:{state:"DRAFT",executorId:null}}),row("Доступная заявка")]);
 mount();expect(await screen.findByRole("button",{name:"Открыть обращение «Доступная заявка»"})).toBeVisible();
 expect(screen.queryByText("Скрытый черновик")).not.toBeInTheDocument();
});
it("sends unseen=1 before every paged request and owns its cache by actor and filter",async()=>{
 mocks.counts.mockResolvedValue({byProject:{bank:19},total:19});
 mocks.tasks.mockImplementation(async(path:string)=>{
  const url=parsed(path);
  if(url.searchParams.get("unseen")!=="1")return [row("Уже просмотренная")];
  return url.searchParams.get("page")==="1"?Array.from({length:500},()=>unseenRow("Первая новая")):[unseenRow("Последняя новая")];
 });
 mount();expect(await screen.findByRole("button",{name:"Открыть обращение «Уже просмотренная»"})).toBeVisible();
 fireEvent.click(await screen.findByRole("button",{name:"Новые в очереди · 19"}));
 expect(await screen.findByRole("button",{name:"Открыть обращение «Последняя новая»"})).toBeVisible();
 expect(screen.queryByRole("button",{name:"Открыть обращение «Уже просмотренная»"})).not.toBeInTheDocument();
 const calls=mocks.tasks.mock.calls.filter(call=>parsed(call[0]).searchParams.get("unseen")==="1");
 expect(calls).toHaveLength(2);
 expect(calls.map(call=>parsed(call[0]).searchParams.get("page"))).toEqual(["1","2"]);
 for(const [path,options] of calls){
  const url=parsed(path);expect(url.searchParams.get("projectId")).toBe("bank");expect(url.searchParams.get("limit")).toBe("500");
  expect(url.searchParams.has("actorId")).toBe(false);expect(options.signal).toBeInstanceOf(AbortSignal);
 }
 expect(client.getQueryCache().find({queryKey:["tasks","bank","applicant","applicant-one",true],exact:true})).toBeDefined();
 expect(client.getQueryCache().find({queryKey:["request-queue-unseen","applicant-one"],exact:true})).toBeDefined();
});
it("uses the authoritative project count even when local search hides every loaded row",async()=>{
 mocks.counts.mockResolvedValue({byProject:{bank:17,other:4},total:21});mocks.tasks.mockResolvedValue([unseenRow("Единственная новая")]);
 mount();expect(await screen.findByRole("button",{name:"Новые в очереди · 17"})).toBeVisible();
 fireEvent.change(screen.getByRole("textbox",{name:"Поиск обращений"}),{target:{value:"Нет совпадений"}});
 expect(screen.queryByRole("button",{name:"Открыть обращение «Единственная новая»"})).not.toBeInTheDocument();
 expect(screen.getByRole("button",{name:"Новые в очереди · 17"})).toBeVisible();
 expect(screen.queryByRole("button",{name:"Новые в очереди · 1"})).not.toBeInTheDocument();
});
it("keeps loading counts unknown instead of falling back to the loaded unseen row count",async()=>{
 const counts=deferred<{byProject:Record<string,number>;total:number}>();mocks.counts.mockReturnValue(counts.promise);
 mocks.tasks.mockResolvedValue([unseenRow("Новая при загрузке счётчика")]);
 mount();expect(await screen.findByRole("button",{name:"Открыть обращение «Новая при загрузке счётчика»"})).toBeVisible();
 expect(screen.getByRole("button",{name:"Новые в очереди"})).toBeVisible();
 expect(screen.queryByRole("button",{name:/Новые в очереди ·/})).not.toBeInTheDocument();
 await act(async()=>{counts.resolve({byProject:{bank:9},total:9});});
 expect(await screen.findByRole("button",{name:"Новые в очереди · 9"})).toBeVisible();
});
it("hides a previous successful count after count refetch fails without discarding readable tasks",async()=>{
 mocks.counts.mockResolvedValue({byProject:{bank:7},total:7});mocks.tasks.mockResolvedValue([unseenRow("Доступная при ошибке счётчика")]);
 mount();expect(await screen.findByRole("button",{name:"Новые в очереди · 7"})).toBeVisible();
 mocks.counts.mockRejectedValue(new Error("Count unavailable"));
 await act(async()=>{await client.invalidateQueries({queryKey:["request-queue-unseen","applicant-one"]});});
 await waitFor(()=>expect(client.getQueryState(["request-queue-unseen","applicant-one"])?.status).toBe("error"));
 expect(screen.getByRole("button",{name:"Новые в очереди"})).toBeVisible();
 expect(screen.queryByRole("button",{name:/Новые в очереди ·/})).not.toBeInTheDocument();
 expect(screen.getByRole("button",{name:"Открыть обращение «Доступная при ошибке счётчика»"})).toBeVisible();
});
it.each(["board","list"] as const)("preserves %s, search, urgency and unseen through a transient error and explicit retry",async view=>{
 let failing=false;
 mocks.tasks.mockImplementation(async()=>{
  if(failing)throw Object.assign(new Error("Transient read failure"),{status:503});
  return [unseenRow("Needle urgent","URGENT"),row("Другой просмотренный результат")];
 });
 mocks.counts.mockResolvedValue({byProject:{bank:3},total:3});
 mount();expect(await screen.findByRole("button",{name:"Открыть обращение «Needle urgent»"})).toBeVisible();
 fireEvent.click(screen.getByRole("button",{name:view==="list"?"Список":"Доска"}));
 fireEvent.change(screen.getByRole("textbox",{name:"Поиск обращений"}),{target:{value:"Needle"}});
 fireEvent.click(screen.getByRole("button",{name:"Срочные"}));
 fireEvent.click(await screen.findByRole("button",{name:"Новые в очереди · 3"}));
 const title=/Открыть (?:задачу|обращение) «Needle urgent»/;
 expect(await screen.findByRole("button",{name:title})).toBeVisible();
 failing=true;await act(async()=>{await client.invalidateQueries({queryKey:["tasks","bank"]});});
 expect(await screen.findByRole("alert")).toHaveTextContent(/Не удалось загрузить/);
 expect(screen.queryByRole("button",{name:title})).not.toBeInTheDocument();
 const assertFilters=()=>{
  expect(screen.getByRole("textbox",{name:"Поиск обращений"})).toHaveValue("Needle");
  expect(screen.getByRole("button",{name:"Срочные"})).toHaveAttribute("aria-pressed","true");
  expect(screen.getByRole("button",{name:"Новые в очереди · 3"})).toHaveAttribute("aria-pressed","true");
  expect(screen.getByRole("button",{name:view==="list"?"Список":"Доска"})).toHaveAttribute("aria-pressed","true");
 };
 assertFilters();failing=false;fireEvent.click(screen.getByRole("button",{name:"Повторить загрузку"}));
 expect(await screen.findByRole("button",{name:title})).toBeVisible();assertFilters();
 expect(parsed(mocks.tasks.mock.calls.at(-1)![0]).searchParams.get("unseen")).toBe("1");
 expect(screen.queryByText("Другой просмотренный результат")).not.toBeInTheDocument();
});
