import {emitUserNotificationChanged} from "@/socket/board-events";
import {readVisibleUnreadTaskNotifications} from "./notifications";
import {hasVisibleAttachmentProvenance} from "./task-change-attachment-provenance";
import {createHash,createHmac,timingSafeEqual} from "node:crypto";
import {Prisma,type PrismaClient} from "@prisma/client";
import {lockProjectStatusAuthority} from "./project-status-policy";
import {loadRoleGrants} from "./role-grants";
import {getTaskReadWhere} from "./project-access";
import {canActorReadInternal,loadProjectDiscussionFacts} from "@/app/api/tasks/[id]/messages/discussion-access";
import {parseStoredAttachments,publicTaskAttachmentDTOs} from "./attachments/task-port";
import {decodeStoredTaskRequest} from "./task-request-marker-lifecycle";
import {TASK_VISIBLE_WORK_ACTIONS} from "./task-change-contract";
import type {TaskChangesResponse,TaskChangeSummary} from "./task-change-contract";

export class TaskChangeError extends Error {
 constructor(readonly status:number,readonly code:string){super(code);this.name="TaskChangeError";}
}
const validId=(id:unknown):id is string=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
const LABELS:Record<string,string>={request_approved:"Счёт принят, заявка закрыта",request_invoice_marked_ready:"Счёт готов",request_submitted:"Заявка отправлена",request_returned_for_revision:"Вернули на доработку",request_taken:"Назначен исполнитель",request_assigned:"Изменён исполнитель",request_info_requested:"Вернули на уточнение",request_info_answered:"Добавлен ответ",request_completed:"Работа выполнена",request_closed:"Заявка закрыта",request_reopened:"Заявка возвращена в работу",request_cancelled:"Заявка отменена",description_changed:"Изменено описание",title_changed:"Изменена тема",priority_changed:"Изменена срочность",deadline_set:"Установлен срок",deadline_changed:"Изменён срок",deadline_removed:"Срок убран",status_changed:"Изменён этап",comment_added:"Добавлен комментарий",comment_edited:"Изменён комментарий",comment_deleted:"Удалён комментарий",attachment_added:"Добавлен файл"};
const SCALAR_ACTIONS=[...TASK_VISIBLE_WORK_ACTIONS];
export type VisibleChange={id:string;kind:string;at:string};
function hash(value:string){return createHash("sha256").update(value).digest("hex");}
export function visibleSnapshotHash(change:VisibleChange|null):string {return hash(JSON.stringify(change));}
function secret(){const value=process.env.NEXTAUTH_SECRET;if(!value||value.length<16)throw new TaskChangeError(503,"TASK_CHANGES_UNAVAILABLE");return value;}
type Token={v:1;actorId:string;taskId:string;projectId:string;hash:string;observedAt:string;notificationHash?:string;notificationCount?:number};
export function signTaskChangeSnapshot(payload:Token):string {
 const body=Buffer.from(JSON.stringify(payload)).toString("base64url");
 return body+"."+createHmac("sha256",secret()).update("task-view-v1:"+body).digest("base64url");
}
export function verifyTaskChangeSnapshot(value:unknown,actorId:string,taskId:string):Token {
 if(!validId(actorId)||!validId(taskId)||typeof value!=="string"||value.length>2048)throw new TaskChangeError(400,"TASK_VIEW_INVALID");
 const parts=value.split(".");if(parts.length!==2)throw new TaskChangeError(400,"TASK_VIEW_INVALID");
 const expected=createHmac("sha256",secret()).update("task-view-v1:"+parts[0]).digest();
 const actual=Buffer.from(parts[1],"base64url");if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new TaskChangeError(400,"TASK_VIEW_INVALID");
 let token:Token;try{token=JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8"));}catch{throw new TaskChangeError(400,"TASK_VIEW_INVALID");}
 if(token.v!==1||token.actorId!==actorId||token.taskId!==taskId||!validId(token.projectId)||!/^([a-f0-9]{64})$/.test(token.hash)||typeof token.observedAt!=="string"||token.observedAt.length>40||!Number.isFinite(Date.parse(token.observedAt)))throw new TaskChangeError(400,"TASK_VIEW_INVALID");
 if(token.notificationHash!==undefined&&(!/^[a-f0-9]{64}$/.test(token.notificationHash)||!Number.isSafeInteger(token.notificationCount)||token.notificationCount!<0))throw new TaskChangeError(400,"TASK_VIEW_INVALID");
 return token;
}
function validDate(value:Date):string|null{return value instanceof Date&&Number.isFinite(value.getTime())?value.toISOString():null;}
function newest(a:VisibleChange|null,b:VisibleChange):VisibleChange {const rank=(event:VisibleChange)=>event.kind==="request_returned_for_revision"?1:0;return !a||b.at>a.at||b.at===a.at&&(rank(b)>rank(a)||rank(b)===rank(a)&&b.id>a.id)?b:a;}
export {hasVisibleAttachmentProvenance} from "./task-change-attachment-provenance";

type Db=Prisma.TransactionClient;
type Actor={id:string;globalRole:"USER"|"ADMIN"};
async function projectSnapshot(db:Db,actor:Actor,projectId:string,taskId?:string,lockedGrants?:Awaited<ReturnType<typeof loadRoleGrants>>):Promise<{response:TaskChangesResponse;hashes:Map<string,string>;observedAt:string;notifications:Map<string,string[]>}> {
 const [clock]=await db.$queryRaw<{at:string}[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "at"`;
 const rows=await db.task.findMany({where:await getTaskReadWhere(actor,{projectId,...(taskId?{id:taskId}:{})},db,{projectId,...(lockedGrants?{roleGrants:lockedGrants}:{})}),select:{id:true,attachments:true,request:{select:{taskId:true,contractVersion:true,state:true,authorId:true,executorId:true,needsInfoSince:true,pausedTotalMs:true,deletedAt:true}}},take:1001});
 if(rows.length>1000)throw new TaskChangeError(503,"TASK_CHANGES_LIMIT");
 const tasks=rows.filter(row=>{if(!row.request)return true;const {deletedAt,...marker}=row.request;const decoded=decodeStoredTaskRequest(marker,row.id);return deletedAt===null&&decoded.valid&&decoded.marker?.state!=="DRAFT";});
 const byTask:Record<string,TaskChangeSummary>=Object.create(null),hashes=new Map<string,string>();
 if(!tasks.length)return {response:{actorId:actor.id,byTask},hashes,observedAt:clock.at,notifications:new Map()};
 const ids=tasks.map(row=>row.id);
 const notifications=await readVisibleUnreadTaskNotifications(db,actor.id,ids);
 const internal=await canActorReadInternal(db,actor,await loadProjectDiscussionFacts(db,projectId));
 const visibility=internal?Prisma.empty:Prisma.sql`AND "isInternal" = false`;
 const [messages,activities,files,receipts]=await Promise.all([
  db.$queryRaw<{id:string;taskId:string;createdAt:Date;editedAt:Date|null;deletedAt:Date|null;version:number}[]>(Prisma.sql`SELECT "id","taskId","createdAt","editedAt","deletedAt","version" FROM "ChatMessage" WHERE "taskId" IN (${Prisma.join(ids)}) ${visibility} ORDER BY "taskId",GREATEST("createdAt","editedAt","deletedAt") DESC,"id" DESC LIMIT 50001`),
  db.activity.findMany({where:{taskId:{in:ids},action:{in:SCALAR_ACTIONS}},select:{id:true,taskId:true,action:true,createdAt:true},orderBy:[{createdAt:"desc"},{id:"desc"}],take:50001}),
  db.activity.findMany({where:{taskId:{in:ids},action:"attachment_added"},select:{id:true,taskId:true,createdAt:true,newValue:true},orderBy:[{createdAt:"desc"},{id:"desc"}],take:50001}),
  db.$queryRaw<{taskId:string;snapshotHash:string}[]>(Prisma.sql`SELECT "taskId","snapshotHash" FROM "TaskViewReceipt" WHERE "userId"=${actor.id} AND "taskId" IN (${Prisma.join(ids)})`),
 ]);
 if(messages.length>50000||activities.length>50000||files.length>50000)throw new TaskChangeError(503,"TASK_CHANGES_LIMIT");
 const latest=new Map<string,VisibleChange|null>(ids.map(id=>[id,null]));
 const fingerprints=new Map<string,VisibleChange[]>(ids.map(id=>[id,[]]));
 const add=(id:string,event:VisibleChange)=>{if(latest.has(id)){latest.set(id,newest(latest.get(id)??null,event));fingerprints.get(id)!.push(event);}};
 for(const row of messages){
  let event:VisibleChange|null=null;
  for(const [kind,date] of [["comment_added",row.createdAt],["comment_edited",row.editedAt],["comment_deleted",row.deletedAt]] as const){const at=date?validDate(date):null;if(at&&(!event||at>=event.at))event={id:`message:${row.id}:${row.version}`,kind,at};}
  if(event)add(row.taskId,event);
 }
 for(const row of activities){const at=validDate(row.createdAt);if(at)add(row.taskId,{id:"activity:"+row.id,kind:row.action,at});}
 const visibleFiles=new Map(tasks.map(task=>[task.id,new Set((internal?parseStoredAttachments(task.attachments):publicTaskAttachmentDTOs(task.attachments)).map(file=>file.url))]));
 for(const row of files){const at=validDate(row.createdAt);if(at&&hasVisibleAttachmentProvenance(row.newValue,visibleFiles.get(row.taskId)??new Set()))add(row.taskId,{id:"file:"+row.id,kind:"attachment_added",at});}
 const seen=new Map(receipts.map(row=>[row.taskId,row.snapshotHash]));
 for(const id of ids){const change=latest.get(id)??null,digest=hash(JSON.stringify(fingerprints.get(id)!.sort((a,b)=>a.id.localeCompare(b.id)||a.at.localeCompare(b.at)||a.kind.localeCompare(b.kind))));hashes.set(id,digest);byTask[id]={latestVisibleChange:change?{kind:change.kind,at:change.at,label:LABELS[change.kind]}:null,snapshotToken:signTaskChangeSnapshot({v:1,actorId:actor.id,taskId:id,projectId,hash:digest,observedAt:clock.at,notificationHash:hash(JSON.stringify(notifications.get(id)??[])),notificationCount:notifications.get(id)?.length??0}),notificationCount:notifications.get(id)?.length??0,unseen:change!==null&&seen.get(id)!==digest};}
 return {response:{actorId:actor.id,byTask},hashes,observedAt:clock.at,notifications};
}
export async function readTaskChanges(database:Pick<PrismaClient,"$transaction">,actor:Actor,projectId:string,taskId?:string):Promise<TaskChangesResponse>{
 if(!validId(projectId)||taskId!==undefined&&!validId(taskId))throw new TaskChangeError(400,"TASK_CHANGES_INVALID");
 try{return await database.$transaction(async db=>(await projectSnapshot(db,actor,projectId,taskId)).response,{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});}
 catch(error){if(error instanceof TaskChangeError)throw error;throw new TaskChangeError(503,"TASK_CHANGES_UNAVAILABLE");}
}
export async function acknowledgeTaskView(database:Pick<PrismaClient,"$transaction">,actor:Actor,taskId:string,expectedActorId:string,snapshotToken:unknown):Promise<{changed:boolean;stale:boolean}>{
 if(!validId(taskId)||expectedActorId!==actor.id)throw new TaskChangeError(403,"TASK_VIEW_ACTOR_CHANGED");
 const token=verifyTaskChangeSnapshot(snapshotToken,actor.id,taskId);
 try{const result=await database.$transaction(async db=>{
  // Serialize receipt ACKs only; common read policy is freshly rechecked below.
  const projects=await db.$queryRaw<{id:string}[]>`SELECT "id" FROM "Project" WHERE "id"=${token.projectId} FOR UPDATE`;
  const tasks=await db.$queryRaw<{id:string}[]>`SELECT "id" FROM "Task" WHERE "id"=${taskId} AND "projectId"=${token.projectId} FOR UPDATE`;
  if(projects.length!==1||tasks.length!==1)throw new TaskChangeError(404,"TASK_NOT_FOUND");
  await lockProjectStatusAuthority(db,actor.id,token.projectId);
  await db.$queryRaw`SELECT d."id" FROM "Department" d JOIN "Project" p ON p."departmentId"=d."id" WHERE p."id"=${token.projectId} FOR SHARE OF d`;
  await db.$queryRaw`SELECT "userId" FROM "TaskWatcher" WHERE "taskId"=${taskId} AND "userId"=${actor.id} FOR SHARE`;
  await db.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${actor.id} FOR SHARE`;
  const currentActor=await db.user.findUnique({where:{id:actor.id},select:{id:true,globalRole:true,isBlocked:true,blockedAt:true}});
  if(!currentActor||currentActor.isBlocked||currentActor.blockedAt!==null)throw new TaskChangeError(404,"TASK_NOT_FOUND");
  const lockedGrants=await loadRoleGrants(db,[actor.id],{lock:true});
  const fresh=await projectSnapshot(db,currentActor,token.projectId,taskId,lockedGrants);
  if(!fresh.hashes.has(taskId))throw new TaskChangeError(404,"TASK_NOT_FOUND");
  const ids=fresh.notifications.get(taskId)??[];
  // Notification mismatch is a rejected shown-set ACK, not even a view receipt.
  // This keeps all read state unchanged when arrival/read/visibility raced.
  if(token.notificationHash!==undefined&&hash(JSON.stringify(ids))!==token.notificationHash)return {changed:false,stale:true};
  const changed=await db.$executeRaw`INSERT INTO "TaskViewReceipt" ("taskId","userId","snapshotHash","viewedAt","observedAt") VALUES (${taskId},${actor.id},${token.hash},clock_timestamp(),${token.observedAt}::timestamptz) ON CONFLICT ("taskId","userId") DO UPDATE SET "snapshotHash"=EXCLUDED."snapshotHash","viewedAt"=EXCLUDED."viewedAt","observedAt"=EXCLUDED."observedAt" WHERE "TaskViewReceipt"."observedAt" < EXCLUDED."observedAt"`;
  const stale=fresh.hashes.get(taskId)!==token.hash;
  // A constant-size signed digest binds the exact shown ID set. Any concurrent
  // arrival/read/revocation changes the set: leave all notifications unread and refetch.
  let notificationsRead=0;
  if(!stale&&token.notificationHash!==undefined&&ids.length){
   const updated=await db.notification.updateMany({where:{userId:actor.id,read:false,id:{in:ids}},data:{read:true,readAt:new Date()}});
   if(updated.count!==ids.length)throw new TaskChangeError(409,"TASK_VIEW_NOTIFICATION_RACE");
   notificationsRead=updated.count;
  }
  return {changed:changed===1||notificationsRead>0,stale};
 },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
 if(result.changed)emitUserNotificationChanged(actor.id);
 return result;}
 catch(error){if(error instanceof TaskChangeError)throw error;throw new TaskChangeError(503,"TASK_VIEW_UNAVAILABLE");}
}
