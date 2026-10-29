import {cleanup,render,screen} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
const runtime=vi.hoisted(()=>({api:vi.fn(),actor:"author"}));
vi.mock("@/lib/api",()=>({apiFetch:runtime.api}));
vi.mock("next-auth/react",()=>({useSession:()=>({data:{user:{id:runtime.actor}}})}));
vi.mock("@/lib/activity-logger",()=>({getActivityDescription:()=>"Изменён статус обращения"}));
import {ActivityTimeline} from "./ActivityTimeline";
const event={id:"event",action:"message_edited",createdAt:"2026-10-27T10:00:00Z",user:{id:"author",name:"Анна",email:"author@example.invalid",avatarUrl:null},oldValue:{messageId:"message",contentText:"Первый ответ",isInternal:false},newValue:{messageId:"message",contentText:"Уточнённый ответ",isInternal:false}};
let client:QueryClient;
afterEach(()=>{cleanup();client?.clear();runtime.api.mockReset();runtime.actor="author";});
const mount=()=>{client=new QueryClient({defaultOptions:{queries:{retry:false}}});return render(<QueryClientProvider client={client}><ActivityTimeline taskId="task"/></QueryClientProvider>);};
it("separately renders who edited a message, when, and its before/after text without nested scroll panes",async()=>{
 runtime.api.mockResolvedValue([event]);const view=mount();await screen.findByText("Анна изменил сообщение");expect(screen.getByText("Было")).toBeInTheDocument();expect(screen.getByText("Стало")).toBeInTheDocument();expect(screen.getByText("Первый ответ")).toBeInTheDocument();expect(screen.getByText("Уточнённый ответ")).toBeInTheDocument();expect(screen.getByText(/2026/)).toBeInTheDocument();expect(view.container.querySelector("[data-radix-scroll-area-viewport]")).toBeNull();
});
it("shows the previous text and a deletion marker in business history",async()=>{
 runtime.api.mockResolvedValue([{...event,action:"message_deleted",newValue:{...event.newValue,contentText:""}}]);mount();await screen.findByText("Анна удалил сообщение");expect(screen.getByText("Первый ответ")).toBeInTheDocument();expect(screen.getByText("Сообщение удалено")).toBeInTheDocument();
});
it("does not expose another actor's warm cached history before a fresh authorized response",async()=>{
 client=new QueryClient({defaultOptions:{queries:{retry:false}}});client.setQueryData(["activities","task","author"],[event]);runtime.actor="other";runtime.api.mockReturnValue(new Promise(()=>{}));render(<QueryClientProvider client={client}><ActivityTimeline taskId="task"/></QueryClientProvider>);expect(screen.queryByText("Первый ответ")).toBeNull();expect(screen.getByText("Загрузка истории действий…")).toBeInTheDocument();
});

it("renders message change text as plain text and names attachment actions without exposing file data",async()=>{
 const html='<img src=x onerror="alert(1)">';
 runtime.api.mockResolvedValue([{...event,oldValue:{...event.oldValue,contentText:html}},{...event,id:"removed",action:"attachment_removed",newValue:{count:1,url:"PRIVATE_FILE_URL"}},{...event,id:"added",action:"attachment_added",newValue:{count:2}}]);
 const view=mount();await screen.findByText(html);expect(view.container.querySelector("img")).toBeNull();expect(screen.getByText("Анна убрал вложение из обращения (1)")).toBeInTheDocument();expect(screen.getByText("Анна добавил вложения в обращение (2)")).toBeInTheDocument();expect(screen.queryByText("PRIVATE_FILE_URL")).toBeNull();
});
