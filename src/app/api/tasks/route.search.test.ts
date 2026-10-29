import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/task-visible-message-counts", () => ({ readVisibleMessageCounts: async (_db: unknown, _actor: unknown, ids: readonly string[]) => new Map(ids.map(id => [id, { total: 0, unread: 0 }])) }));
// Queue authority has its own core/route suites; preserve this suite's list ACL scope.
vi.mock("@/lib/request-queue-unseen", () => ({ readRequestQueueArrivalMap: async (_db: unknown, _actor: string, ids: string[]) => new Map(ids.map(id => [id, null])) }));
const mocks = vi.hoisted(()=>({auth:vi.fn(),readWhere:vi.fn(),list:vi.fn(),raw:vi.fn(),counts:vi.fn(),limit:vi.fn(),urgentCount:vi.fn()}));
vi.mock("@/lib/prisma",()=>({prisma:{project:{findUnique:async()=>null},task:{findMany:mocks.list,count:mocks.urgentCount},$queryRaw:mocks.raw,taskChecklistItem:{groupBy:mocks.counts}}}));
vi.mock("@/lib/require-api-user",()=>({requireApiUser:mocks.auth,UnauthorizedError:class UnauthorizedError extends Error{}}));
vi.mock("@/lib/project-access",()=>({getTaskReadWhere:mocks.readWhere}));
vi.mock("@/lib/rate-limit",()=>({rateLimitOrThrowKey:mocks.limit,rateLimitErrorResponse:vi.fn()}));
import {GET} from "./route";
import {taskSearchPredicate,TASK_SEARCH_QUERY_LIMIT} from "@/lib/task-search";
import {TASK_SEARCH_LIMIT} from "@/lib/task-list-limits";
const actor={id:"author",globalRole:"USER"};
const listVisibility = { OR: [
 { request: { is: null } },
 { request: { is: { contractVersion: 1, state: { not: "DRAFT" }, deletedAt: null } } },
] };
const run=(query:string)=>GET(new Request(`http://localhost/api/tasks?${query}`));
beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockResolvedValue(actor);mocks.readWhere.mockImplementation(async(_actor,filter)=>({AND:[{id:{in:["authorized-task"]}},filter]}));mocks.list.mockResolvedValue([]);mocks.urgentCount.mockResolvedValue(0);mocks.raw.mockResolvedValue([]);mocks.counts.mockResolvedValue([]);});
describe("authorized task search and minimized request DTO",()=>{
 it("composes the name/content predicate with shared permission scope before fixed-limit search",async()=>{
  expect((await run("search=%20Анна%20&projectId=board&page=9&limit=500")).status).toBe(200);
  const filters={AND:[{projectId:"board"},taskSearchPredicate("Анна")]};
  expect(mocks.readWhere).toHaveBeenCalledWith(actor,filters,expect.anything(),{projectId:"board"});
   expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({where:{AND:[{AND:[{AND:[{id:{in:["authorized-task"]}},filters]},listVisibility]},{priority:{in:["CRITICAL","URGENT","HIGH"]}}]},skip:0,take:TASK_SEARCH_LIMIT+1}));
 });
 it("treats whitespace as a normal paginated list, bounds real search and uses the existing actor quota",async()=>{
  await run("search=%20%20%20&page=2&limit=25");expect(mocks.list.mock.calls[0][0]).toMatchObject({skip:25,take:26});
  await run(`search=${"a".repeat(400)}`);const filter=mocks.readWhere.mock.calls[1][1];expect(filter.AND[1].OR[0].title.contains).toHaveLength(TASK_SEARCH_QUERY_LIMIT);expect(mocks.limit).toHaveBeenCalledWith("tasks:list",actor.id);
 });
 it("returns only a personal flag and actual canonical people, never audience IDs",async()=>{
  mocks.list.mockResolvedValueOnce([{id:"authorized-task",projectId:"board",project:{id:"board",name:"Поддержка"},title:"Visible",_count:{messages:0,checklistItems:0},request:{state:"IN_PROGRESS",executorId:"executor",audienceUserIds:["private-recipient-1","private-recipient-2"],author:{id:"author",name:"Анна",email:"hidden@example.invalid"},executor:{id:"executor",name:"Борис",email:"also-hidden@example.invalid"}}}]);
  const response=await run("search=Анна");const body=await response.json();
  expect(body.data[0].request).toEqual({state:"IN_PROGRESS",executorId:"executor",beznalPhase:null,isPersonal:true,author:{id:"author",name:"Анна"},executor:{id:"executor",name:"Борис"}});
  expect(JSON.stringify(body)).not.toMatch(/audienceUserIds|private-recipient|@example.invalid/);
  expect(mocks.list.mock.calls[0][0].include.request.select).toEqual({state:true,executorId:true,audienceUserIds:true,beznalPhase:true,author:{select:{id:true,name:true}},executor:{select:{id:true,name:true}}});
 });
 it("keeps general and legacy requests distinguishable without inventing personal data",async()=>{
  mocks.list.mockResolvedValueOnce([{id:"general",project:{id:"board",name:"Поддержка"},_count:{messages:0,checklistItems:0},request:{state:"SUBMITTED",executorId:null,audienceUserIds:[],author:{id:"author",name:null},executor:null}},{id:"legacy",request:null,_count:{messages:0,checklistItems:0}}]);
  const body=await(await run("")).json();expect(body.data[0].request.isPersonal).toBe(false);expect(body.data[1].request).toBeNull();
 });
 it.each(["USER", "ADMIN"])("excludes canonical drafts and deleted requests from every list read for %s while retaining legacy rows", async globalRole => {
   const reader = { ...actor, globalRole };
   mocks.auth.mockResolvedValue(reader);
   // ADMIN's read policy is unrestricted; the list constraint must still hold.
   const access = globalRole === "ADMIN" ? {} : { request: { is: { authorId: actor.id } } };
   mocks.readWhere.mockResolvedValue(access);
   for (const query of ["limit=8", "page=2&limit=2", "search=author&page=9&limit=500",
     "requestScope=mine&assignedToMe=true&projectId=board&columnId=new&search=author"]) {
     mocks.list.mockClear(); mocks.urgentCount.mockClear();
     expect((await run(query)).status).toBe(200);
     expect(mocks.list).toHaveBeenCalled();
     for (const [options] of [...mocks.list.mock.calls, ...mocks.urgentCount.mock.calls]) {
       expect(options.where.AND[0]).toEqual({ AND: [access, listVisibility] });
       // Both urgency buckets/counts receive this narrowing before skip/take,
       // never an OR which could revive a draft matching the search or author.
       expect(options.where.AND[0].AND[1].OR[0]).toEqual({ request: { is: null } });
       expect(options.where.AND[0].AND[1].OR[1].request.is).toEqual({
         contractVersion: 1, state: { not: "DRAFT" }, deletedAt: null,
       });
     }
   }
   expect(mocks.readWhere).toHaveBeenLastCalledWith(reader, {
     AND: [{ projectId: "board", columnId: "new", OR: [
       { request: { is: { contractVersion: 1, executorId: actor.id, deletedAt: null } } },
       { request: { is: null }, assignees: { some: { userId: actor.id } } },
     ], AND: [{ OR: [
       { request: { is: { contractVersion: 1, authorId: actor.id, deletedAt: null } } },
       { request: { is: null }, createdById: actor.id },
     ] }] }, taskSearchPredicate("author")],
   }, expect.anything(), { projectId: "board" });
 });
});

it('paginates the urgent/normal union under shared access before trimming, with created-time and ID ties', async () => {
  const records = [
    { id: 'urgent-a', priority: 'CRITICAL', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'normal-new', priority: 'LOW', createdAt: '2026-10-27T00:00:00Z' },
    { id: 'urgent-old', priority: 'HIGH', createdAt: '2025-01-01T00:00:00Z' },
    { id: 'urgent-z', priority: 'URGENT', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'hidden-urgent', priority: 'HIGH', createdAt: '2026-12-01T00:00:00Z' },
    { id: 'normal-old', priority: 'MEDIUM', createdAt: '2026-10-26T00:00:00Z' },
  ];
  const access = { id: { not: 'hidden-urgent' } };
  mocks.readWhere.mockResolvedValue(access);
  const visible = records.filter(row => row.id !== 'hidden-urgent');
   mocks.urgentCount.mockImplementation(async ({where}) => { expect(where.AND[0]).toEqual({AND:[access,listVisibility]}); return visible.filter(row => ['HIGH','URGENT','CRITICAL'].includes(row.priority)).length; });
  mocks.list.mockImplementation(async ({where,orderBy,skip,take}) => {
     expect(where.AND[0]).toEqual({AND:[access,listVisibility]});
    expect(orderBy).toEqual([{createdAt:'desc'},{id:'desc'}]);
    const urgent = Boolean(where.AND[1].priority.in);
    return visible.filter(row => ['HIGH','URGENT','CRITICAL'].includes(row.priority) === urgent)
      .sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(skip,skip+take).map(row=>({...row,request:null,_count:{messages:0,checklistItems:0}}));
  });
  const first = await (await run('page=1&limit=2')).json();
  expect(first.data.map((row:{id:string})=>row.id)).toEqual(['urgent-z','urgent-a']);
  expect(first.meta.hasMore).toBe(true);expect(mocks.urgentCount).not.toHaveBeenCalled();
  const second = await (await run('page=2&limit=2')).json();
  expect(second.data.map((row:{id:string})=>row.id)).toEqual(['urgent-old','normal-new']);
  expect(second.meta.hasMore).toBe(true);
  const third = await (await run('page=3&limit=2')).json();
  expect(third.data.map((row:{id:string})=>row.id)).toEqual(['normal-old']);
  expect(third.meta.hasMore).toBe(false);expect(mocks.urgentCount).toHaveBeenCalledTimes(2);
});
