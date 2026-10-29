/** Opaque invalidation only: no task identity, actor counts or shared unseen flag. */
export const REQUEST_QUEUE_INVALIDATED = "request:queue:invalidated" as const;
export type RequestQueueInvalidation = Record<string, never>;
export interface RequestQueueServerToClientEvents {
  "request:queue:invalidated": (payload: RequestQueueInvalidation) => void;
}

export function isRequestQueueInvalidation(value: unknown): value is RequestQueueInvalidation {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 0;
}
