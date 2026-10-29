import {NOTIFICATION_CHANGED,isNotificationChanged} from "./notification-change-contract";
import { REQUEST_QUEUE_INVALIDATED, isRequestQueueInvalidation } from './request-queue-contract';

const ALLOWED_EVENTS = new Set([
  "message:new",
  "message:updated",
  "task:created",
  "task:updated",
  "task:moved",
  "task:deleted",
  "column:created",
  "column:updated",
  "column:deleted",
  "columns:reordered",
  "project:members:updated",
  "project:member:deleted",
]);

const ROOM_REGEX = /^project:([A-Za-z0-9_-]{1,128})$/;
const USER_ROOM_REGEX = /^user:([A-Za-z0-9_-]{1,128})$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export interface InternalEmitPayload {
  event: string;
  roomId: string;
  data: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function matchProjectId(obj: Record<string, unknown>, expectedId: string): boolean {
  return !("projectId" in obj) || obj.projectId === expectedId;
}

export function isInternalEmitPayload(value: unknown): value is InternalEmitPayload {
  if (!isPlainObject(value)) return false;
  const { event, roomId, data } = value;

  if(event===NOTIFICATION_CHANGED)return typeof roomId==="string"&&USER_ROOM_REGEX.test(roomId)&&isNotificationChanged(data);
  if (event === REQUEST_QUEUE_INVALIDATED) {
    return typeof roomId === 'string' && USER_ROOM_REGEX.test(roomId) && isRequestQueueInvalidation(data);
  }

  if (event === "notification:new") {
    if (typeof roomId !== "string") return false;
    const recipient = USER_ROOM_REGEX.exec(roomId)?.[1];
    return Boolean(recipient && isPlainObject(data) && isId(data.id) &&
      data.userId === recipient && typeof data.type === "string" && data.type.length > 0 && data.type.length <= 128 &&
      typeof data.title === "string" && typeof data.message === "string" && typeof data.read === "boolean");
  }
  if (event === "auth.revoked") {
    if (typeof roomId !== "string") return false;
    const recipient = USER_ROOM_REGEX.exec(roomId)?.[1];
    return Boolean(recipient && isPlainObject(data) && data.userId === recipient &&
      typeof data.reason === "string" && data.reason.length > 0 && data.reason.length <= 128);
  }
  if (typeof event !== "string" || !ALLOWED_EVENTS.has(event)) return false;
  if (typeof roomId !== "string") return false;
  const roomMatch = ROOM_REGEX.exec(roomId);
  if (!roomMatch) return false;
  const projectId = roomMatch[1];

  if (event === "columns:reordered") {
    if (!Array.isArray(data)) return false;
    return data.every((col) => isPlainObject(col) && isId(col.id) && matchProjectId(col, projectId));
  }

  if (!isPlainObject(data) || !matchProjectId(data, projectId)) return false;

  switch (event) {
    case "message:new":
    case "message:updated":
      return isId(data.id) && isId(data.taskId) && isId(data.authorId)
        && isPlainObject(data.author) && data.author.id === data.authorId
        && typeof data.contentText === "string" && data.contentText.length <= 20_000
        && Array.isArray(data.attachments)
        && (data.visibility === "PUBLIC" || data.visibility === "INTERNAL")
        && data.isInternal === (data.visibility === "INTERNAL");
    case "task:created":
    case "task:updated":
      return isId(data.id);
    case "task:deleted":
      return isId(data.taskId);
    case "task:moved": {
      const { operationId, boardRevision, task } = data;
      return (
        typeof operationId === "string" &&
        UUID_REGEX.test(operationId) &&
        typeof boardRevision === "number" &&
        Number.isSafeInteger(boardRevision) &&
        boardRevision >= 0 &&
        isPlainObject(task) &&
        isId(task.id) &&
        isId(task.columnId) &&
        typeof task.version === "number" && Number.isSafeInteger(task.version) && task.version >= 0 &&
        typeof task.status === "string" &&
        matchProjectId(task, projectId)
      );
    }
    case "column:created":
    case "column:updated":
      return isId(data.id);
    case "column:deleted":
      return isId(data.columnId);
    case "project:members:updated":
      return isId(data.id);
    case "project:member:deleted":
      return isId(data.memberId);
    default:
      return false;
  }
}
