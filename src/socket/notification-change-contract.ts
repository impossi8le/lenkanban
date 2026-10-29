/** Opaque personal invalidation; never an event, task identity or count. */
export const NOTIFICATION_CHANGED = "notification:changed" as const;
export type NotificationChanged = {version:1};
export interface NotificationChangeServerToClientEvents { "notification:changed": (payload:NotificationChanged)=>void }
export function isNotificationChanged(value:unknown):value is NotificationChanged{
 return typeof value==="object"&&value!==null&&!Array.isArray(value)&&Object.keys(value).length===1&&"version" in value&&value.version===1;
}
