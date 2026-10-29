import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ io:{use:vi.fn(),on:vi.fn(),to:vi.fn()}, command:vi.fn(),task:vi.fn(),rate:vi.fn() }));
vi.mock("@prisma/client",async original=>({...await original<typeof import("@prisma/client")>(),PrismaClient:class{constructor(){return {};}}}));
vi.mock("socket.io",()=>({Server:class{constructor(){return mock.io;}}}));
vi.mock("@/lib/chat-message-command",async original=>({...await original<typeof import("@/lib/chat-message-command")>(),changeOwnMessage:mock.command}));
vi.mock("@/lib/notification-triggers",()=>({notifyChatMessage:vi.fn()}));
vi.mock("@/lib/logger",()=>({socketLogger:{debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
vi.mock("@/lib/rate-limit",()=>({rateLimitOrThrowKey:mock.rate}));
vi.mock("./visibility-delivery",()=>({createVisibilityDelivery:()=>({task:mock.task,revalidate:vi.fn(),dispatch:vi.fn()})}));
type Handler=(body:unknown,ack?:(value:unknown)=>void)=>Promise<void>;
let handlers:Map<string,Handler>;
const payload={taskId:"task",messageId:"message",operationId:"11111111-1111-4111-8111-111111111111",expectedVersion:0};
const ackValue={taskId:"task",messageId:"message",version:1,changed:true,replayed:false};
beforeEach(async()=>{
 vi.useFakeTimers();vi.resetModules();vi.resetAllMocks();await import("./server");handlers=new Map();
 mock.io.on.mock.calls.find(([name])=>name==="connection")![1]({id:"socket",data:{userId:"actor",userName:"Actor",globalRole:"ADMIN"},on:(name:string,fn:Handler)=>handlers.set(name,fn),emit:vi.fn(),to:vi.fn()});
 mock.command.mockResolvedValue({ack:ackValue,projectId:"project",message:{id:"message",taskId:"task",contentText:"",deletedAt:"date",attachments:[],mentions:[],reactions:{},isInternal:false}});
});
afterEach(async()=>{await handlers?.get("disconnect")?.(undefined);vi.useRealTimers();});
it.each(["edit","delete"] as const)("routes %s through the same own-message command and broadcasts a committed safe DTO",async action=>{
 const ack=vi.fn();const body={...payload,...(action==="edit"?{contentText:"After"}:{})};await handlers.get("message:"+action)!(body,ack);
 expect(mock.command).toHaveBeenCalledExactlyOnceWith({}, {...body,actorId:"actor",action});expect(mock.rate).toHaveBeenCalledWith("tasks:update","actor");expect(ack).toHaveBeenCalledExactlyOnceWith({ok:true,data:ackValue});
 expect(mock.task).toHaveBeenCalledWith("task","message:updated",expect.objectContaining({contentText:"",attachments:[]}),"project");
});
it.each(["edit","delete"] as const)("never repeats %s broadcast on receipt replay",async action=>{mock.command.mockResolvedValue({ack:{...ackValue,replayed:true},projectId:"project",message:null});const ack=vi.fn();await handlers.get("message:"+action)!({...payload,...(action==="edit"?{contentText:"After"}:{})},ack);expect(ack).toHaveBeenCalledWith({ok:true,data:{...ackValue,replayed:true}});expect(mock.task).not.toHaveBeenCalled();});
it.each([{taskId:"task",messageId:"message",contentText:"After"},{...payload,contentText:"After",attachments:[]},{...payload,contentText:"After",isInternal:false},{...payload,expectedVersion:-1,contentText:"After"}])("rejects unsupported or unversioned edit input %j before authority",async body=>{const ack=vi.fn();await handlers.get("message:edit")!(body,ack);expect(ack).toHaveBeenCalledWith({ok:false,error:"InvalidMessageCommand"});expect(mock.command).not.toHaveBeenCalled();});
it("never fabricates success after a shared command CAS denial",async()=>{const { TaskCommandError } = await import("@/lib/task-command");mock.command.mockRejectedValue(new TaskCommandError("STALE_TASK_VERSION"));const ack=vi.fn();await handlers.get("message:delete")!(payload,ack);expect(ack).toHaveBeenCalledWith({ok:false,error:"MutationRejected"});expect(mock.task).not.toHaveBeenCalled();});
it("keeps committed success when postcommit delivery fails",async()=>{mock.task.mockRejectedValue(Error("private"));const ack=vi.fn();await handlers.get("message:delete")!(payload,ack);expect(ack).toHaveBeenCalledExactlyOnceWith({ok:true,data:ackValue});});
