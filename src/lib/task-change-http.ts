import {apiError,apiForbidden,apiUnauthorized} from "./api-response";
import {UnauthorizedError,ForbiddenError} from "./errors";
import {TaskChangeError} from "./task-change-snapshot";
export function taskChangesNoStore(response:Response):Response {response.headers.set("Cache-Control","no-store");return response;}
/** Never forward raw exceptions, SQL parameters, snapshot tokens or task contents. */
export function taskChangesFailure(error:unknown):Response {
 if(error instanceof UnauthorizedError)return taskChangesNoStore(apiUnauthorized());
 if(error instanceof ForbiddenError)return taskChangesNoStore(apiForbidden());
 if(error instanceof TaskChangeError)return taskChangesNoStore(apiError(error.code,"Не удалось получить отметку изменений",undefined,error.status));
 return taskChangesNoStore(apiError("TASK_CHANGES_UNAVAILABLE","Не удалось получить отметку изменений",undefined,503));
}
