import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({transaction:vi.fn(),project:vi.fn(),column:vi.fn(),auth:vi.fn(),emit:vi.fn(),automation:vi.fn(),prepare:vi.fn(),policy:vi.fn()}));
vi.mock("@/lib/prisma",()=>({prisma:{$transaction:api.transaction,project:{findFirst:api.project},projectColumn:{findFirst:api.column}}}));
vi.mock("@/lib/require-api-user",async()=>({requireApiUser:api.auth,UnauthorizedError:(await import("@/lib/errors")).UnauthorizedError}));
vi.mock("@/lib/project-creation-policy",()=>({getProjectCreationPolicy:api.policy,isCreationColumnAllowed:()=>true}));
vi.mock("@/socket/board-events",()=>({emitTaskCreated:api.emit}));
vi.mock("@/lib/automation-processor",()=>({processAutomationRules:api.automation}));
vi.mock("@/lib/rate-limit",()=>({rateLimitOrThrowKey:vi.fn(),rateLimitErrorResponse:vi.fn()}));
vi.mock("@/features/kanban/server/task-creation-port",()=>({prepareLegacyTaskCreation:api.prepare}));
import { POST } from "./route";
const projectId="project",columnId="todo",operationId="00000000-0000-4000-8000-000000000001";
const map={contractVersion:1,submittedColumnId:"todo",inProgressColumnId:"work",needsInfoColumnId:"info",completedColumnId:"review",closedColumnId:"done"};
const config={id:projectId,departmentId:null as string|null,department:null as {id:string;archivedAt:Date|null}|null,responsibleGroupId:"group",responsibleGroup:{archivedAt:null as Date|null},lifecycleColumnMap:map,columns:[{id:"todo",projectId,workflowKey:"TODO"},{id:"work",projectId,workflowKey:"IN_PROGRESS"},{id:"info",projectId,workflowKey:"NEEDS_INFO"},{id:"review",projectId,workflowKey:"REVIEW"},{id:"done",projectId,workflowKey:"DONE"}]};
function fixture(){
 let receipt:Record<string,unknown>|null=null;const trace:string[]=[];
 const board=structuredClone(config);
 const people=[{id:"one",primaryDepartmentId:"department",isBlocked:false,blockedAt:null as Date|null,groupIds:["group"]},{id:"two",primaryDepartmentId:"department",isBlocked:false,blockedAt:null as Date|null,groupIds:["group"]}];
 const tx={
  $queryRaw:vi.fn(async(parts:TemplateStringsArray)=>{trace.push(parts.join("?").includes('ResponsibleGroupMember')?"membership-lock":"lock");return[{id:"locked"}];}),
  user:{findUnique:vi.fn(async()=>({id:"author",globalRole:"USER"})),findMany:vi.fn(async({where}:{where:{AND:[{primaryDepartmentId?:string;isBlocked:boolean;blockedAt:null;responsibleGroupMemberships?:{some:{groupId:string;group:{archivedAt:null}}}},{id:{in:string[]}}]}})=>{
    trace.push("recipients-check");const [staff,selected]=where.AND;
    expect(staff.isBlocked).toBe(false);expect(staff.blockedAt).toBeNull();
    return people.filter(person=>selected.id.in.includes(person.id)&&!person.isBlocked&&person.blockedAt===null&&(staff.primaryDepartmentId?person.primaryDepartmentId===staff.primaryDepartmentId:person.groupIds.includes(staff.responsibleGroupMemberships!.some.groupId))).map(({id})=>({id}));
  })},
  project:{findUnique:vi.fn(async()=>board)},
  responsibleGroupMember:{findMany:vi.fn()},
  task:{findFirst:vi.fn(async()=>null),create:vi.fn(async({data}:{data:Record<string,unknown>})=>{trace.push("task-write");return{id:"task",...data,version:0};})},
  taskRequest:{create:vi.fn(async()=>{})},activity:{create:vi.fn(async()=>{})},
  taskMoveOperation:{findUnique:vi.fn(async()=>{trace.push("receipt-read");return receipt;}),create:vi.fn(async({data}:{data:Record<string,unknown>})=>{receipt=data;})},
 };
 api.transaction.mockImplementation((fn:(client:typeof tx)=>unknown)=>fn(tx));
 const run=(extra:object={})=>POST(new Request("http://localhost/api/tasks",{method:"POST",body:JSON.stringify({projectId,columnId,title:"Request",operationId,audience:{mode:"SELECTED",userIds:["one"]},...extra})}));
 return{tx,run,trace,board,people,revoke:()=>{people.forEach(person=>{person.groupIds=[];});}};
}
beforeEach(()=>{vi.resetAllMocks();api.auth.mockResolvedValue({id:"author",globalRole:"USER"});api.project.mockResolvedValue(config);api.column.mockResolvedValue({id:columnId});api.policy.mockResolvedValue({canCreate:true,allowedColumnIds:null});api.prepare.mockResolvedValue({column:{id:columnId,workflowKey:"TODO"},rank:"0|HZZZZZZZZZZZZZZZZZZZ"});});
describe("create frozen request audience (mock transaction, no real DB)",()=>{
 it("persists selected IDs as canonical DRAFT even without requestDetails, before effects",async()=>{const f=fixture();expect((await f.run()).status).toBe(201);expect(f.tx.taskRequest.create).toHaveBeenCalledWith({data:{taskId:"task",contractVersion:1,state:"DRAFT",authorId:"author",audienceUserIds:["one"]}});expect(f.trace.indexOf("membership-lock")).toBeLessThan(f.trace.indexOf("recipients-check"));expect(f.trace.indexOf("recipients-check")).toBeLessThan(f.trace.indexOf("receipt-read"));expect(f.trace.indexOf("recipients-check")).toBeLessThan(f.trace.indexOf("task-write"));expect(api.emit).toHaveBeenCalledOnce();});
 it("does not silently ignore selected audience in the non-receipt compatibility path",async()=>{const f=fixture();expect((await f.run({operationId:undefined})).status).toBe(201);expect(f.tx.taskRequest.create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({audienceUserIds:["one"]})}));expect(f.trace.indexOf("recipients-check")).toBeLessThan(f.trace.indexOf("task-write"));});
 it("rejects unknown recipients before receipt lookup, task write and effects",async()=>{const f=fixture();expect((await f.run({audience:{mode:"SELECTED",userIds:["stranger"]}})).status).toBe(403);expect(f.tx.taskMoveOperation.findUnique).not.toHaveBeenCalled();expect(f.tx.task.create).not.toHaveBeenCalled();expect(api.emit).not.toHaveBeenCalled();expect(api.automation).not.toHaveBeenCalled();});
 it("refreshes active group eligibility before disclosing a retry receipt",async()=>{const f=fixture();expect((await f.run()).status).toBe(201);f.revoke();f.tx.taskMoveOperation.findUnique.mockClear();expect((await f.run()).status).toBe(403);expect(f.tx.taskMoveOperation.findUnique).not.toHaveBeenCalled();expect(f.tx.task.create).toHaveBeenCalledOnce();});
 it("freezes audience in the intent hash and treats recipient order as set order",async()=>{const f=fixture();expect((await f.run({audience:{mode:"SELECTED",userIds:["two","one"]}})).status).toBe(201);const retry=await f.run({audience:{mode:"SELECTED",userIds:["one","two"]}});expect(retry.status).toBe(201);expect(await retry.json()).toMatchObject({data:{replayed:true}});expect((await f.run({audience:{mode:"SELECTED",userIds:["one"]}})).status).toBe(409);expect(f.tx.task.create).toHaveBeenCalledOnce();expect(api.emit).toHaveBeenCalledOnce();});
 it("stores whole-department audience as an explicit empty array",async()=>{const f=fixture();expect((await f.run({audience:{mode:"DEPARTMENT",userIds:[]}})).status).toBe(201);expect(f.tx.taskRequest.create).toHaveBeenCalledWith({data:{taskId:"task",contractVersion:1,state:"DRAFT",authorId:"author",audienceUserIds:[]}});expect(f.tx.user.findMany).not.toHaveBeenCalled();});
 it("rejects a structured missing audience without any transaction",async()=>{const f=fixture();expect((await f.run({audience:undefined,requestDetails:{kind:"it",category:"Звук"}})).status).toBe(422);expect(api.transaction).not.toHaveBeenCalled();});
});


it("validates selected people against the destination department rather than old group membership",async()=>{
 const f=fixture();f.board.departmentId="department";f.board.department={id:"department",archivedAt:null};
 f.people.forEach(person=>{person.groupIds=[];});
 expect((await f.run()).status).toBe(201);
 expect(f.tx.user.findMany).toHaveBeenCalledWith({where:{AND:[{primaryDepartmentId:"department",isBlocked:false,blockedAt:null},{id:{in:["one"]}}]},select:{id:true}});
 expect(f.tx.taskRequest.create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({audienceUserIds:["one"]})}));
});
it.each(["blocked","other-department","archived-department"])("rejects a fresh %s recipient before writes even if previously selected",async kind=>{
 const f=fixture();f.board.departmentId="department";f.board.department={id:"department",archivedAt:null};
 if(kind==="blocked")f.people[0].isBlocked=true;
 if(kind==="other-department")f.people[0].primaryDepartmentId="other";
 if(kind==="archived-department")f.board.department.archivedAt=new Date();
 expect((await f.run()).status).toBe(403);expect(f.tx.task.create).not.toHaveBeenCalled();expect(f.tx.taskMoveOperation.findUnique).not.toHaveBeenCalled();expect(api.emit).not.toHaveBeenCalled();
});
