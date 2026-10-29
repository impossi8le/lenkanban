import {z} from "zod";
import {prisma} from "@/lib/prisma";
import {requireApiUser} from "@/lib/require-api-user";
import {apiSuccess} from "@/lib/api-response";
import {withApiLogging} from "@/middleware/api-logger";
import {rateLimitOrThrowKey,rateLimitErrorResponse} from "@/lib/rate-limit";
import {readTaskChanges,TaskChangeError} from "@/lib/task-change-snapshot";
import {taskChangesNoStore,taskChangesFailure} from "@/lib/task-change-http";
const schema=z.object({projectId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),taskId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional()});
export async function GET(request:Request):Promise<Response>{
 return withApiLogging(request,async(request,context)=>{
  try{
   const actor=await requireApiUser(request);context.actorId=actor.id;
   try{await rateLimitOrThrowKey("tasks:list",actor.id);}catch{return taskChangesNoStore(rateLimitErrorResponse({}));}
   const url=new URL(request.url),query=schema.safeParse({projectId:url.searchParams.get("projectId"),taskId:url.searchParams.get("taskId")??undefined});
   if(!query.success)throw new TaskChangeError(400,"TASK_CHANGES_INVALID");
   return taskChangesNoStore(apiSuccess(await readTaskChanges(prisma,actor,query.data.projectId,query.data.taskId)));
  }catch(error){return taskChangesFailure(error);}
 },{route:"/api/tasks/changes"});
}
