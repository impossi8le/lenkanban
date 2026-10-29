import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const runtime=vi.hoisted(()=>({api:vi.fn(),post:vi.fn(),socket:{connected:true,on:vi.fn(),off:vi.fn(),emit:vi.fn()}}));
vi.mock("@/lib/api",()=>({apiFetch:runtime.api,apiPost:runtime.post}));
vi.mock("next-auth/react",()=>({useSession:()=>({data:{user:{id:"author",name:"Автор"}}})}));
vi.mock("@/hooks/useTaskChat",()=>({useTaskChat:()=>({socket:runtime.socket,isConnected:true,isJoined:true,lastError:null})}));
import {TaskChatPanel} from "./TaskChatPanel";
const message={id:"message",taskId:"task",clientId:null,authorId:"author",author:{id:"author",name:"Анна Петрова",email:"author@example.invalid",avatarUrl:null},contentText:"Последнее сообщение",attachments:[],mentions:[],reactions:{},createdAt:"2026-10-27T09:30:00Z",version:3,canEdit:true,canDelete:true,editedAt:null as string|null,deletedAt:null as string|null};
let client:QueryClient;
beforeEach(()=>{
 runtime.api.mockReset();runtime.socket.emit.mockReset();runtime.socket.on.mockReset();
 const frame=document.createElement("iframe");document.body.appendChild(frame);vi.stubGlobal("localStorage",frame.contentWindow!.localStorage);vi.stubGlobal("sessionStorage",frame.contentWindow!.sessionStorage);localStorage.clear();sessionStorage.clear();
 client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 runtime.api.mockResolvedValue({items:[message],nextCursor:null});
});
afterEach(()=>{cleanup();client.clear();vi.restoreAllMocks();vi.unstubAllGlobals();document.querySelectorAll("iframe").forEach(frame=>frame.remove());});
const panel=(taskId="task")=><QueryClientProvider client={client}><TaskChatPanel taskId={taskId} mode="thread"/></QueryClientProvider>;

it("uses natural height, readable messages and an explicit three-line composer",async()=>{
 const view=render(panel());await screen.findByText(message.contentText);
 const conversation=screen.getByTestId("task-conversation");expect(conversation).toHaveAttribute("data-mode","thread");expect(conversation).not.toHaveClass("h-full","overflow-hidden");
 expect(view.container.querySelector("[data-radix-scroll-area-viewport]")).toBeNull();
 expect(screen.getByText(message.contentText)).toHaveClass("text-[18px]","leading-relaxed");expect(screen.getByText("Анна Петрова")).toHaveClass("text-base");
 expect(screen.getByRole("textbox",{name:"Сообщение"})).toHaveAttribute("rows","3");
 expect(screen.getByText("Прикрепить файлы")).toBeVisible();expect(screen.getByRole("button",{name:"Отправить сообщение"})).toHaveClass("min-h-12");
 expect(screen.getByRole("button",{name:"Изменить сообщение"})).toHaveTextContent("Изменить");
});

it("saves a versioned edit, retains draft on uncertainty and retries the exact operation",async()=>{
 let current={...message},refuse=true;const writes:unknown[]=[];
 runtime.api.mockImplementation(async (_path:string,init?:RequestInit)=>{
  if(init?.method==="PATCH"){const body=JSON.parse(String(init.body));writes.push(body);if(refuse){refuse=false;throw new Error("SYNTHETIC_RAW_SECRET");}current={...current,contentText:body.contentText,version:4,editedAt:"2026-10-27T10:00:00Z"};return {version:4};}
  return {items:[current],nextCursor:null};
 });
 render(panel());fireEvent.click(await screen.findByRole("button",{name:"Изменить сообщение"}));
 fireEvent.change(screen.getByRole("textbox",{name:"Текст сообщения"}),{target:{value:"Уточнённый ответ"}});fireEvent.click(screen.getByRole("button",{name:"Сохранить"}));
 expect(await screen.findByRole("alert")).toHaveTextContent("Введённый текст сохранён");expect(screen.getByRole("textbox",{name:"Текст сообщения"})).toHaveValue("Уточнённый ответ");expect(screen.queryByText(/SYNTHETIC_RAW_SECRET/)).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Сохранить"}));await screen.findByText("Уточнённый ответ");await screen.findByText(/Изменено/);
 expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);expect(writes[0]).toMatchObject({operationId:expect.any(String),expectedVersion:3,contentText:"Уточнённый ответ"});
 expect(runtime.socket.emit.mock.calls.some(([event])=>event==="message:edit")).toBe(false);
});

it("soft-deletes through the versioned endpoint and renders only a tombstone",async()=>{
 let current={...message,attachments:[{url:"/photo",name:"photo.jpg",size:5,mime:"image/jpeg"}]};
 runtime.api.mockImplementation(async (_path:string,init?:RequestInit)=>{
  if(init?.method==="DELETE"){expect(JSON.parse(String(init.body))).toMatchObject({expectedVersion:3,operationId:expect.any(String)});current={...current,deletedAt:"2026-10-27T10:00:00Z"};return {version:4};}
  return {items:[current],nextCursor:null};
 });
 render(panel());fireEvent.click(await screen.findByRole("button",{name:"Удалить сообщение"}));await screen.findByText("Сообщение удалено");
 expect(screen.queryByText(message.contentText)).toBeNull();expect(screen.queryByRole("img",{name:"photo.jpg"})).toBeNull();expect(screen.queryByRole("button",{name:"Изменить сообщение"})).toBeNull();expect(screen.queryByRole("button",{name:"Удалить сообщение"})).toBeNull();
});

it("does not infer mutation rights from authorship or invalid message versions",async()=>{
 runtime.api.mockResolvedValue({items:[{...message,canEdit:false,canDelete:false},{...message,id:"invalid",contentText:"Без версии",version:undefined}],nextCursor:null});
 render(panel());await screen.findByText("Без версии");expect(screen.queryByRole("button",{name:"Изменить сообщение"})).toBeNull();expect(screen.queryByRole("button",{name:"Удалить сообщение"})).toBeNull();
});

it("loads older pages without duplicate rows or overwriting newer data and preserves the reading anchor",async()=>{
 runtime.api.mockImplementation(async (path:string)=>path.includes("cursor=")?{items:[{...message,id:"old",contentText:"Предыдущее сообщение"},{...message,id:"old",contentText:"Предыдущее сообщение"},{...message,contentText:"Устаревшее содержимое"}],nextCursor:null}:{items:[message],nextCursor:"cursor-older"});
 const view=render(<div data-testid="task-detail-scroll">{panel()}</div>);await screen.findByText(message.contentText);
 const anchor=view.container.querySelector<HTMLElement>('[data-message-id="message"]')!;
 vi.spyOn(anchor,"getBoundingClientRect").mockImplementation(()=>({top:view.container.querySelector('[data-message-id="old"]')?340:100} as DOMRect));
 const scroll=screen.getByTestId("task-detail-scroll");scroll.scrollTop=40;
 fireEvent.click(screen.getByRole("button",{name:"Показать предыдущие сообщения"}));await screen.findByText("Предыдущее сообщение");
 expect(screen.getAllByText("Предыдущее сообщение")).toHaveLength(1);expect(screen.getByText(message.contentText)).toBeInTheDocument();expect(screen.queryByText("Устаревшее содержимое")).toBeNull();
 await waitFor(()=>expect(scroll.scrollTop).toBe(280));expect(screen.queryByRole("button",{name:"Показать предыдущие сообщения"})).toBeNull();
});

it("ignores an older-page result after switching tasks",async()=>{
 let resolve!:(value:unknown)=>void;
 runtime.api.mockImplementation(async (path:string)=>path.includes("cursor=")?new Promise(done=>resolve=done):{items:[{...message,taskId:path.includes("/next/")?"next":"task",contentText:path.includes("/next/")?"Другая переписка":message.contentText}],nextCursor:"older"});
 const view=render(panel());await screen.findByText(message.contentText);fireEvent.click(screen.getByRole("button",{name:"Показать предыдущие сообщения"}));
 await waitFor(()=>expect(resolve).toBeDefined());view.rerender(panel("next"));await screen.findByText("Другая переписка");
 const request=runtime.api.mock.calls.find(([path])=>path.includes("cursor="));expect(request?.[1].signal.aborted).toBe(true);
 await act(async()=>resolve({items:[{...message,id:"late",contentText:"Поздняя старая страница"}],nextCursor:null}));
 expect(screen.queryByText("Поздняя старая страница")).toBeNull();expect(screen.getByText("Другая переписка")).toBeInTheDocument();
});

it("uses a new intent and freshly read message version after a definitive conflict",async()=>{
 let current={...message};const writes:Array<{operationId:string;expectedVersion:number}>=[];
 runtime.api.mockImplementation(async (_path:string,init?:RequestInit)=>{
  if(init?.method==="PATCH"){const body=JSON.parse(String(init.body));writes.push(body);if(writes.length===1){current={...current,version:4,contentText:"Параллельная правка"};throw Object.assign(new Error("SYNTHETIC_RAW"),{status:409,payload:{error:{code:"STALE_MESSAGE_VERSION"}}});}current={...current,version:5,contentText:"Мой уточнённый ответ"};return {version:5};}
  return {items:[current],nextCursor:null};
 });
 render(panel());fireEvent.click(await screen.findByRole("button",{name:"Изменить сообщение"}));fireEvent.change(screen.getByRole("textbox",{name:"Текст сообщения"}),{target:{value:"Мой уточнённый ответ"}});fireEvent.click(screen.getByRole("button",{name:"Сохранить"}));
 expect(await screen.findByRole("alert")).toHaveTextContent("Сообщение уже изменилось");
 await waitFor(()=>expect(client.getQueryData<{items:Array<{version:number}>}>(["task-messages","task"])?.items[0].version).toBe(4));
 expect(screen.getByRole("textbox",{name:"Текст сообщения"})).toHaveValue("Мой уточнённый ответ");fireEvent.click(screen.getByRole("button",{name:"Сохранить"}));await screen.findByText("Мой уточнённый ответ");
 expect(writes.map(value=>value.expectedVersion)).toEqual([3,4]);expect(writes[1].operationId).not.toBe(writes[0].operationId);
});

it("does not let completion of a previous task edit close the current task editor",async()=>{
 let resolve!:(value:unknown)=>void;
 runtime.api.mockImplementation(async (path:string,init?:RequestInit)=>init?.method==="PATCH"?new Promise(done=>resolve=done):{items:[{...message,id:path.includes("/next/")?"next-message":"message",taskId:path.includes("/next/")?"next":"task",contentText:path.includes("/next/")?"Другая переписка":message.contentText}],nextCursor:null});
 const view=render(panel());fireEvent.click(await screen.findByRole("button",{name:"Изменить сообщение"}));fireEvent.change(screen.getByRole("textbox",{name:"Текст сообщения"}),{target:{value:"Первая правка"}});fireEvent.click(screen.getByRole("button",{name:"Сохранить"}));await waitFor(()=>expect(resolve).toBeDefined());
 view.rerender(panel("next"));await screen.findByText("Другая переписка");fireEvent.click(screen.getByRole("button",{name:"Изменить сообщение"}));fireEvent.change(screen.getByRole("textbox",{name:"Текст сообщения"}),{target:{value:"Вторая правка"}});
 await act(async()=>resolve({version:4}));expect(screen.getByRole("textbox",{name:"Текст сообщения"})).toHaveValue("Вторая правка");
});

it("separates delete intent from an uncertain edit whose text is literally delete",async()=>{
 let current={...message};let editBody:Record<string,unknown>|undefined,deleteBody:Record<string,unknown>|undefined;
 runtime.api.mockImplementation(async (_path:string,init?:RequestInit)=>{
  if(init?.method==="PATCH"){editBody=JSON.parse(String(init.body));throw new Error("Unknown edit result");}
  if(init?.method==="DELETE"){deleteBody=JSON.parse(String(init.body));current={...current,version:4,deletedAt:"2026-10-27T10:00:00Z"};return {version:4};}
  return {items:[current],nextCursor:null};
 });
 render(panel());fireEvent.click(await screen.findByRole("button",{name:"Изменить сообщение"}));
 fireEvent.change(screen.getByRole("textbox",{name:"Текст сообщения"}),{target:{value:"delete"}});fireEvent.click(screen.getByRole("button",{name:"Сохранить"}));
 expect(await screen.findByRole("alert")).toHaveTextContent("Введённый текст сохранён");
 expect(screen.getByRole("textbox",{name:"Текст сообщения"})).toHaveValue("delete");
 fireEvent.click(screen.getByRole("button",{name:"Удалить сообщение"}));await screen.findByText("Сообщение удалено");
 expect(editBody).toEqual({operationId:expect.any(String),expectedVersion:3,contentText:"delete"});
 expect(deleteBody).toEqual({operationId:expect.any(String),expectedVersion:3});
 expect(deleteBody?.operationId).not.toBe(editBody?.operationId);
});

it("keeps earlier-page loading retryable and never displays raw errors",async()=>{
 runtime.api.mockImplementation(async (path:string)=>{if(path.includes("cursor="))throw new Error("SYNTHETIC_PRIVATE_ERROR");return {items:[message],nextCursor:"older"};});
 render(panel());await screen.findByText(message.contentText);fireEvent.click(screen.getByRole("button",{name:"Показать предыдущие сообщения"}));
 expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить предыдущие сообщения");expect(screen.getByRole("button",{name:"Показать предыдущие сообщения"})).not.toBeDisabled();expect(screen.queryByText(/SYNTHETIC_PRIVATE_ERROR/)).toBeNull();
});
