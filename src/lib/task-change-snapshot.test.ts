vi.mock("@/socket/board-events",()=>({emitUserNotificationChanged:access.changed}));
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {Prisma,type PrismaClient} from "@prisma/client";
const access=vi.hoisted(()=>({read:vi.fn(),internal:vi.fn(),changed:vi.fn()}));
vi.mock("./project-access",()=>({getTaskReadWhere:access.read}));
vi.mock("@/app/api/tasks/[id]/messages/discussion-access",()=>({loadProjectDiscussionFacts:vi.fn(async()=>({projectId:"board"})),canActorReadInternal:access.internal}));
vi.mock("./project-status-policy",()=>({lockProjectStatusAuthority:vi.fn(async()=>true)}));
vi.mock("./role-grants",()=>({loadRoleGrants:vi.fn(async()=>[])}));
import {acknowledgeTaskView,readTaskChanges,verifyTaskChangeSnapshot,visibleSnapshotHash,hasVisibleAttachmentProvenance} from "./task-change-snapshot";
const actor={id:"reader",globalRole:"USER" as const};
const at=(time:string)=>new Date(`2026-10-28T${time}:00.000Z`);
beforeEach(()=>{vi.stubEnv("NEXTAUTH_SECRET","test-only-shared-secret-123456789");access.read.mockImplementation(async(_actor,filters)=>filters);access.internal.mockResolvedValue(false);});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
function fixture(){
 const state={allowed:true,blocked:false,clock:at("15:00"),receipt:null as null|{taskId:string;snapshotHash:string;observedAt:string},
 notifications:[] as {id:string;userId:string;read:boolean;type:string;metadata:object;actionUrl:string;createdAt:Date}[],
 tasks:[{id:"ticket",projectId:"board",attachments:[] as unknown[],request:{taskId:"ticket",contractVersion:1,state:"SUBMITTED",authorId:"author",executorId:null,needsInfoSince:null,pausedTotalMs:0,deletedAt:null}}],
 messages:[] as {id:string;taskId:string;createdAt:Date;editedAt:Date|null;deletedAt:Date|null;isInternal:boolean;version:number}[],
 activities:[] as {id:string;taskId:string;action:string;createdAt:Date;newValue?:unknown}[]};
 const raw=vi.fn(async(query:TemplateStringsArray|Prisma.Sql,...args:unknown[])=>{
  const text=(Array.isArray(query)?query:(query as Prisma.Sql).strings).join("?");const values=Array.isArray(query)?args:(query as Prisma.Sql).values;
  if(text.includes("to_char"))return [{at:state.clock.toISOString()}];
  if(text.includes('FROM "ChatMessage"'))return state.messages.filter(message=>!text.includes('"isInternal" = false')||!message.isInternal).sort((a,b)=>Math.max(b.createdAt.getTime(),b.editedAt?.getTime()??0,b.deletedAt?.getTime()??0)-Math.max(a.createdAt.getTime(),a.editedAt?.getTime()??0,a.deletedAt?.getTime()??0));
  if(text.includes('FROM "TaskViewReceipt"'))return state.receipt?[state.receipt]:[];
  if(text.includes('FROM "Project"')||text.includes('FROM "Task"'))return [{id:values[0]}];
  return [];
 });
 const execute=vi.fn(async(_query:TemplateStringsArray,...values:unknown[])=>{
  const [taskId,,hash,time]=values as string[];
  if(state.receipt&&state.receipt.observedAt>=time)return 0;
  state.receipt={taskId,snapshotHash:hash,observedAt:time};return 1;
 });
 const tx={notification:{findMany:vi.fn(async({skip=0,take=100}:{skip?:number;take?:number})=>state.notifications.filter(row=>!row.read).slice(skip,skip+take)),updateMany:vi.fn(async({where}:{where:{id:{in:string[]}}})=>{let count=0;for(const row of state.notifications)if(where.id.in.includes(row.id)&&!row.read){row.read=true;count++;}return {count};})},$queryRaw:raw,$executeRaw:execute,user:{findUnique:vi.fn(async()=>({...actor,isBlocked:state.blocked,blockedAt:null}))},task:{findMany:vi.fn(async()=>state.allowed?state.tasks:[])},activity:{findMany:vi.fn(async({where}:{where:{action:string|{in:string[]}}})=>state.activities.filter(row=>typeof where.action==="string"?row.action===where.action:where.action.in.includes(row.action)))}};
 const db={$transaction:vi.fn(async(fn:(db:unknown)=>unknown)=>{const before=structuredClone({receipt:state.receipt,notifications:state.notifications});try{return await fn(tx);}catch(error){state.receipt=before.receipt;state.notifications=before.notifications;throw error;}})} as unknown as Pick<PrismaClient,"$transaction">;
 const read=async()=>(await readTaskChanges(db,actor,"board")).byTask.ticket;
 const ack=async(token:string)=>acknowledgeTaskView(db,actor,"ticket",actor.id,token);
 return {state,tx,db,read,ack};
}
const message=(id="public",internal=false)=>({id,taskId:"ticket",createdAt:at("14:00"),editedAt:null,deletedAt:null,isInternal:internal,version:0});
it("projects the shared actor ACL and ignores raw task version/updatedAt and unsafe Activity",async()=>{
 const f=fixture();f.state.activities.push({id:"old",taskId:"ticket",action:"attachment_added",createdAt:at("14:20"),newValue:{count:1}},{id:"internal-comment",taskId:"ticket",action:"comment_added",createdAt:at("14:30")});
 const result=await f.read();expect(result.latestVisibleChange).toBeNull();expect(result.unseen).toBe(false);
 expect(access.read).toHaveBeenCalledWith(actor,{projectId:"board"},f.tx,{projectId:"board"});
 f.state.allowed=false;expect((await readTaskChanges(f.db,actor,"board")).byTask).toEqual({});
 expect(f.tx.$executeRaw).not.toHaveBeenCalled();
});
it("keeps outsider digest unchanged for hidden messages and files, including reclassified current files",async()=>{
 const f=fixture();f.state.messages.push(message());const before=await f.read();await f.ack(before.snapshotToken);
 f.state.messages.push({...message("hidden",true),createdAt:at("14:40")});
 const url="/api/tasks/ticket/files/example";f.state.tasks[0].attachments.push({url,name:"PRIVATE FILE",size:1,mime:"application/pdf",isInternal:true});
 f.state.activities.push({id:"file",taskId:"ticket",action:"attachment_added",createdAt:at("14:45"),newValue:{files:[{url,isInternal:false}]}});
 f.state.clock=at("15:01");const after=await f.read();expect(after.unseen).toBe(false);expect(after.latestVisibleChange).toEqual(before.latestVisibleChange);
 const payload=verifyTaskChangeSnapshot(after.snapshotToken,actor.id,"ticket");expect(payload.hash).toBe(verifyTaskChangeSnapshot(before.snapshotToken,actor.id,"ticket").hash);expect(JSON.stringify(after)).not.toContain("PRIVATE FILE");
});
it("projects exact public created/edit/delete timestamps and permits internal events only via shared policy",async()=>{
 const f=fixture();f.state.messages.push({...message(),editedAt:at("14:10")});expect((await f.read()).latestVisibleChange).toEqual({kind:"comment_edited",label:"Изменён комментарий",at:at("14:10").toISOString()});
 f.state.messages[0].deletedAt=at("14:11");expect((await f.read()).latestVisibleChange?.kind).toBe("comment_deleted");
 f.state.messages.push({...message("hidden",true),createdAt:at("14:40")});access.internal.mockResolvedValue(true);
 expect((await f.read()).latestVisibleChange?.at).toBe(at("14:40").toISOString());
});
it("acknowledges only shown snapshot, old ACK never hides a newer event or overwrites newer receipt",async()=>{
 const f=fixture();f.state.messages.push(message());const old=await f.read();
 f.state.messages[0].editedAt=at("15:01");f.state.clock=at("15:02");
 expect(await f.ack(old.snapshotToken)).toEqual({changed:true,stale:true});expect((await f.read()).unseen).toBe(true);
 const fresh=await f.read();expect(await f.ack(fresh.snapshotToken)).toEqual({changed:true,stale:false});expect((await f.read()).unseen).toBe(false);
 expect(await f.ack(old.snapshotToken)).toEqual({changed:false,stale:true});expect((await f.read()).unseen).toBe(false);
 expect(await f.ack(fresh.snapshotToken)).toEqual({changed:false,stale:false});
});
it("advances watermark for later identical snapshots so a delayed older different snapshot cannot replace them",async()=>{
 const f=fixture();f.state.messages.push(message());const a=await f.read();await f.ack(a.snapshotToken);
 f.state.messages[0].editedAt=at("15:01");f.state.clock=at("15:02");const b=await f.read();
 f.state.messages[0].editedAt=null;f.state.clock=at("15:03");const aLater=await f.read();await f.ack(aLater.snapshotToken);
 expect(await f.ack(b.snapshotToken)).toEqual({changed:false,stale:true});expect((await f.read()).unseen).toBe(false);
});
it("rejects forged/wrong actor/task tokens and freshly revoked/blocked readers without receipt writes",async()=>{
 const f=fixture();f.state.messages.push(message());const before=await f.read();
 expect(()=>verifyTaskChangeSnapshot(before.snapshotToken+"x",actor.id,"ticket")).toThrow();
 expect(()=>verifyTaskChangeSnapshot(before.snapshotToken,"other","ticket")).toThrow();expect(()=>verifyTaskChangeSnapshot(before.snapshotToken,actor.id,"other")).toThrow();
 await expect(acknowledgeTaskView(f.db,actor,"ticket","other",before.snapshotToken)).rejects.toMatchObject({status:403});
 f.state.allowed=false;await expect(f.ack(before.snapshotToken)).rejects.toMatchObject({status:404});
 f.state.allowed=true;f.state.blocked=true;await expect(f.ack(before.snapshotToken)).rejects.toMatchObject({status:404});expect(f.tx.$executeRaw).not.toHaveBeenCalled();
});
it("uses safe canonical lifecycle labels and exact new provenance, omits malformed/legacy metadata",async()=>{
 const f=fixture();f.state.activities.push({id:"info",taskId:"ticket",action:"request_info_requested",createdAt:at("14:20"),newValue:{reason:"PRIVATE REASON"}});
 expect((await f.read()).latestVisibleChange).toEqual({kind:"request_info_requested",label:"Вернули на уточнение",at:at("14:20").toISOString()});
 expect(hasVisibleAttachmentProvenance({count:1},new Set(["file"]))).toBe(false);
 expect(hasVisibleAttachmentProvenance({files:[{url:"file"}]},new Set(["file"]))).toBe(false);
 expect(hasVisibleAttachmentProvenance({files:[{url:"file",isInternal:false}]},new Set(["file"]))).toBe(true);
 expect(visibleSnapshotHash(null)).toMatch(/^[a-f0-9]{64}$/);
});
it("fails closed on missing receipt storage and does not leak raw SQL errors",async()=>{
 const f=fixture();f.tx.$queryRaw.mockRejectedValue(new Error("PRIVATE SQL QUERY PARAMS"));
 await expect(f.read()).rejects.toMatchObject({status:503,code:"TASK_CHANGES_UNAVAILABLE"});
});

it("suppresses duplicate public file metadata when that same URL is currently internal",async()=>{
 const f=fixture(),url="/api/tasks/ticket/files/shared";
 f.state.tasks[0].attachments.push({url,name:"file",size:1,mime:"application/pdf"},{url,name:"hidden",size:1,mime:"application/pdf",isInternal:true});
 f.state.activities.push({id:"file-event",taskId:"ticket",action:"attachment_added",createdAt:at("14:30"),newValue:{files:[{url,isInternal:false}]}});
 expect((await f.read()).latestVisibleChange).toBeNull();
});
it("does not emit foreign drafts or corrupt markers even if an injected repository returns them",async()=>{
 const f=fixture();f.state.tasks[0].request.state="DRAFT";expect((await readTaskChanges(f.db,actor,"board")).byTask).toEqual({});
 f.state.tasks[0].request.contractVersion=2;expect((await readTaskChanges(f.db,actor,"board")).byTask).toEqual({});
});

it("includes same-millisecond message revision even when another visible source wins the display tie",async()=>{
 const f=fixture();f.state.messages.push({...message(),editedAt:at("14:20"),version:1});
 f.state.activities.push({id:"tie",taskId:"ticket",action:"request_info_requested",createdAt:at("14:20")});
 const initial=await f.read();await f.ack(initial.snapshotToken);f.state.messages[0].version=2;f.state.clock=at("15:01");
 expect((await f.read()).unseen).toBe(true);
});
it.each(["title_changed","priority_changed","deadline_set","deadline_changed","deadline_removed"])("projects fixed canonical scalar label for %s without values",async(action)=>{
 const f=fixture();f.state.activities.push({id:"scalar",taskId:"ticket",action,createdAt:at("14:20"),newValue:{text:"PRIVATE SCALAR"}});
 const result=await f.read();expect(result.latestVisibleChange?.kind).toBe(action);expect(JSON.stringify(result)).not.toContain("PRIVATE SCALAR");
});

it("does not lose an edit on another message at the same exact timestamp",async()=>{
 const f=fixture();f.state.messages.push({...message("a"),createdAt:at("14:20")},{...message("z"),createdAt:at("14:20")});
 const before=await f.read();await f.ack(before.snapshotToken);
 f.state.messages[0].editedAt=at("14:20");f.state.messages[0].version=1;f.state.clock=at("15:01");expect((await f.read()).unseen).toBe(true);
});
it("chooses maximum actual message date and delete wins an equal timestamp",async()=>{
 const f=fixture();f.state.messages.push({...message(),editedAt:at("14:30"),deletedAt:at("14:20")});
 expect((await f.read()).latestVisibleChange?.kind).toBe("comment_edited");
 f.state.messages[0].deletedAt=at("14:30");expect((await f.read()).latestVisibleChange?.kind).toBe("comment_deleted");
});

it("prefers return business label over its public reason message at the same transaction timestamp",async()=>{
 const f=fixture();f.state.messages.push(message("reason"));f.state.activities.push({id:"return",taskId:"ticket",action:"request_returned_for_revision",createdAt:at("14:00")});
 expect((await f.read()).latestVisibleChange).toEqual({kind:"request_returned_for_revision",at:at("14:00").toISOString(),label:"Вернули на доработку"});
});

it("ignores trusted discussion-draft provenance even when current legacy metadata is public",async()=>{
 const f=fixture(),url="public-file";f.state.tasks[0].attachments.push({url,name:"file",mime:"application/pdf",size:1});f.state.activities.push({id:"staged",taskId:"ticket",action:"attachment_added",createdAt:at("14:30"),newValue:{discussionDraft:true,files:[{url,isInternal:false}]}});expect((await f.read()).latestVisibleChange).toBeNull();
});

const notice=(id:string)=>({id,userId:"reader",read:false,type:"chat_message",metadata:{taskId:"ticket",projectId:"board",visibility:"PUBLIC"},actionUrl:"/projects/board/board?task=ticket",createdAt:at("14:00")});
it("visible unchanged task still carries unread events and viewing atomically reads exactly its bound IDs",async()=>{
 const f=fixture();f.state.messages.push(message());await f.ack((await f.read()).snapshotToken);
 f.state.notifications.push(notice("notice-a"));const shown=await f.read();expect(shown.unseen).toBe(false);expect(shown.notificationCount).toBe(1);
 expect(await f.ack(shown.snapshotToken)).toMatchObject({changed:true,stale:false});expect(f.state.notifications[0].read).toBe(true);
 expect((await f.read()).notificationCount).toBe(0);
});
it("new event ID after snapshot is never cleared by old ACK even when business snapshot is identical",async()=>{
 const f=fixture();f.state.notifications.push(notice("notice-a"));const old=await f.read();f.state.notifications.push(notice("notice-b"));
 expect(await f.ack(old.snapshotToken)).toMatchObject({stale:true});expect(f.state.notifications.every(n=>!n.read)).toBe(true);expect(f.state.receipt).toBeNull();expect(f.tx.$executeRaw).not.toHaveBeenCalled();
 const fresh=await f.read();expect(fresh.notificationCount).toBe(2);await f.ack(fresh.snapshotToken);expect(f.state.notifications.every(n=>n.read)).toBe(true);
});
it("notification write failure rolls back view receipt and leaves every event unread",async()=>{
 const f=fixture();f.state.notifications.push(notice("notice-a"));const shown=await f.read();f.tx.notification.updateMany.mockRejectedValueOnce(Error("synthetic-private"));
 await expect(f.ack(shown.snapshotToken)).rejects.toMatchObject({code:"TASK_VIEW_UNAVAILABLE"});expect(f.state.receipt).toBeNull();expect(f.state.notifications[0].read).toBe(false);expect(access.changed).not.toHaveBeenCalled();
});
it("token remains bounded for large exact ID sets and never discloses those IDs",async()=>{
 const f=fixture();for(let i=0;i<1000;i++)f.state.notifications.push(notice("notice-private-"+i));const shown=await f.read();expect(shown.notificationCount).toBe(1000);expect(shown.snapshotToken.length).toBeLessThan(1000);expect(Buffer.from(shown.snapshotToken.split(".")[0],"base64url").toString()).not.toContain("notice-private");
});

it("fresh revoked internal visibility cannot acknowledge an earlier internal notification set",async()=>{
 const f=fixture();access.internal.mockResolvedValue(true);f.state.notifications.push({...notice("internal"),metadata:{taskId:"ticket",projectId:"board",visibility:"INTERNAL"}});const shown=await f.read();expect(shown.notificationCount).toBe(1);
 access.internal.mockResolvedValue(false);expect(await f.ack(shown.snapshotToken)).toMatchObject({stale:true});expect(f.state.notifications[0].read).toBe(false);
});
it("read-row conflict rolls back both the view receipt and notification write",async()=>{
 const f=fixture();f.state.notifications.push(notice("conflict"));const shown=await f.read();f.tx.notification.updateMany.mockResolvedValueOnce({count:0});
 await expect(f.ack(shown.snapshotToken)).rejects.toMatchObject({status:409,code:"TASK_VIEW_NOTIFICATION_RACE"});expect(f.state.receipt).toBeNull();expect(f.state.notifications[0].read).toBe(false);expect(access.changed).not.toHaveBeenCalled();
});

it("link-only malformed task notices cannot enter a signed automatic acknowledgement set",async()=>{
 const f=fixture();f.state.notifications.push({...notice("link-only"),metadata:{projectId:"board"}});const shown=await f.read();expect(shown.notificationCount).toBe(0);await f.ack(shown.snapshotToken);expect(f.state.notifications[0].read).toBe(false);expect(f.tx.notification.updateMany).not.toHaveBeenCalled();
});
