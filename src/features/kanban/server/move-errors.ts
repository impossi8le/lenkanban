export type MoveTaskErrorCode =
  | "TASK_NOT_FOUND"
  | "INVALID_DESTINATION_COLUMN"
  | "INVALID_MOVE_NEIGHBORS"
  | "INVALID_MOVE_ROUTE"
  | "STALE_TASK_VERSION"
  | "OPERATION_ID_REUSED"
  | "REQUEST_LIFECYCLE_NOT_ENABLED"
  | "INVALID_REQUEST_MARKER";

export class MoveTaskError extends Error {
  constructor(readonly code: MoveTaskErrorCode) {
    super(code);
    this.name = "MoveTaskError";
  }
}
