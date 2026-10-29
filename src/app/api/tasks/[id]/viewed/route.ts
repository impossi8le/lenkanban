import {z} from "zod";
import {prisma} from "@/lib/prisma";
import {requireApiUser} from "@/lib/require-api-user";
import {apiSuccess} from "@/lib/api-response";
import {withApiLogging} from "@/middleware/api-logger";
import {rateLimitOrThrowKey,rateLimitErrorResponse} from "@/lib/rate-limit";
import {requireTrustedMutationOrigin} from "@/lib/mutation-origin";
import {readTelemetryJson} from "@/lib/telemetry/http";
import {acknowledgeTaskView,TaskChangeError} from "@/lib/task-change-snapshot";
import {taskChangesNoStore,taskChangesFailure} from "@/lib/task-change-http";
const bodySchema=z.object({expectedActorId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),snapshotToken:z.string().min(1).max(2048)}).strict();
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}):Promise<Response>{
 return withApiLogging(request,async(request,context)=>{
  try{
   const actor=await requireApiUser(request);context.actorId=actor.id;requireTrustedMutationOrigin(request);
   try{await rateLimitOrThrowKey("tasks:update",actor.id);}catch{return taskChangesNoStore(rateLimitErrorResponse({}));}
   let parsed;try{parsed=bodySchema.safeParse(await readTelemetryJson(request,{maxBytes:4096}));}catch{throw new TaskChangeError(400,"TASK_VIEW_INVALID");}
   if(!parsed.success)throw new TaskChangeError(400,"TASK_VIEW_INVALID");
   const {id}=await params;
   return taskChangesNoStore(apiSuccess(await acknowledgeTaskView(prisma,actor,id,parsed.data.expectedActorId,parsed.data.snapshotToken)));
  }catch(error){return taskChangesFailure(error);}
 },{route:"/api/tasks/:id/viewed"});
}
