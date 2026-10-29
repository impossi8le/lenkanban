import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {ForbiddenError,UnauthorizedError} from "./errors";
const mocks=vi.hoisted(()=>({actor:vi.fn(),read:vi.fn(),ack:vi.fn(),rate:vi.fn(),origin:vi.fn()}));
vi.mock("./prisma",()=>({prisma:{}}));
vi.mock("./require-api-user",()=>({requireApiUser:mocks.actor}));
vi.mock("./rate-limit",()=>({rateLimitOrThrowKey:mocks.rate,rateLimitErrorResponse:()=>new Response('{}',{status:429})}));
vi.mock("./mutation-origin",()=>({requireTrustedMutationOrigin:mocks.origin}));
vi.mock("@/middleware/api-logger",()=>({withApiLogging:(request:Request,fn:(request:Request,context:unknown)=>Promise<Response>)=>fn(request,{})}));
vi.mock("./telemetry/http",()=>({readTelemetryJson:async(request:Request)=>request.json()}));
vi.mock("./task-change-snapshot",()=>({readTaskChanges:mocks.read,acknowledgeTaskView:mocks.ack,TaskChangeError:class extends Error{constructor(readonly status:number,readonly code:string){super(code);}}}));
import {GET} from "@/app/api/tasks/changes/route";
import {POST} from "@/app/api/tasks/[id]/viewed/route";
const actor={id:"actor",globalRole:"USER"};
const post=(body:unknown={expectedActorId:"actor",snapshotToken:"signed-token"})=>POST(new Request("https://app.test/api/tasks/task/viewed",{method:"POST",headers:{"Content-Type":"application/json",Origin:"https://app.test"},body:JSON.stringify(body)}),{params:Promise.resolve({id:"task"})});
beforeEach(()=>{mocks.actor.mockResolvedValue(actor);mocks.rate.mockResolvedValue(undefined);mocks.origin.mockReturnValue(undefined);mocks.read.mockResolvedValue({actorId:"actor",byTask:{}});mocks.ack.mockResolvedValue({changed:false,stale:true});});
afterEach(()=>vi.resetAllMocks());
it("uses verified actor and exact read scope with no-store; GET has no receipt write",async()=>{
 const response=await GET(new Request("https://app.test/api/tasks/changes?projectId=board&taskId=task"));
 expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");
 expect(mocks.read).toHaveBeenCalledWith({},actor,"board","task");expect(mocks.ack).not.toHaveBeenCalled();
});
it("keeps concrete snapshot ACK shape and applies same-origin before mutation",async()=>{
 const response=await post();expect(await response.json()).toMatchObject({data:{changed:false,stale:true}});
 expect(mocks.origin).toHaveBeenCalled();expect(mocks.ack).toHaveBeenCalledWith({},actor,"task","actor","signed-token");expect(response.headers.get("Cache-Control")).toBe("no-store");
});
it("rejects missing authentication before projecting",async()=>{
 mocks.actor.mockRejectedValue(new UnauthorizedError());const response=await GET(new Request("https://app.test/api/tasks/changes?projectId=board"));
 expect(response.status).toBe(401);expect(mocks.read).not.toHaveBeenCalled();expect((await post()).status).toBe(401);expect(mocks.ack).not.toHaveBeenCalled();
});
it("rejects cross-origin mutation before receipt access",async()=>{
 mocks.origin.mockImplementation(()=>{throw new ForbiddenError();});expect((await post()).status).toBe(403);expect(mocks.ack).not.toHaveBeenCalled();
});
it("rejects malformed scope/body and fail-closes storage errors without raw exception contents",async()=>{
 expect((await GET(new Request("https://app.test/api/tasks/changes?projectId=bad%20id"))).status).toBe(400);expect(mocks.read).not.toHaveBeenCalled();
 expect((await post({expectedActorId:"actor",snapshotToken:"signed-token",extra:"raw"})).status).toBe(400);expect(mocks.ack).not.toHaveBeenCalled();
 mocks.read.mockRejectedValue(new Error("PRIVATE QUERY PARAMS AND CONTENT"));const response=await GET(new Request("https://app.test/api/tasks/changes?projectId=board"));expect(response.status).toBe(503);expect(await response.text()).not.toContain("PRIVATE");
});
it("rate limits before reading sources or writing receipts",async()=>{
 mocks.rate.mockRejectedValue(new Error("limit"));expect((await GET(new Request("https://app.test/api/tasks/changes?projectId=board"))).status).toBe(429);expect((await post()).status).toBe(429);expect(mocks.read).not.toHaveBeenCalled();expect(mocks.ack).not.toHaveBeenCalled();
});
