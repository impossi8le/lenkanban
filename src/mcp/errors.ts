export const statuses = {
  UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, INVALID_ARGUMENT: 422, INVALID_CURSOR: 400,
  STALE_VERSION: 409, OPERATION_ID_REUSED: 409, IDENTITY_CHANGED: 409, VERSION_EXHAUSTED: 409,
  INVALID_DESTINATION_COLUMN: 422, INVALID_MOVE_NEIGHBORS: 422, REQUEST_LIFECYCLE_NOT_ENABLED: 409,
  INVALID_REQUEST_MARKER: 409, RATE_LIMITED: 429, PAYLOAD_TOO_LARGE: 413,
  DEPENDENCY_UNAVAILABLE: 503, INTERNAL_ERROR: 500, PAGINATION_LIMIT: 400,
} as const;
export type ErrorCode = keyof typeof statuses;
export class McpError extends Error {
  constructor(readonly code: ErrorCode, readonly retryAfterSec: number | null = null, readonly disabled = false) { super(code); }
}
export class RpcError extends Error {
  constructor(readonly code: number) { super("Запрос протокола отклонён"); }
}
export function safeError(error: unknown): McpError {
  return error instanceof McpError ? error : new McpError("INTERNAL_ERROR");
}
export function failure(error: McpError, requestId: string) {
  return { content: [{ type: "text", text: "Запрос отклонён" }], isError: true,
    structuredContent: { schemaVersion: 1, error: { code: error.code,
      message: error.disabled ? "Инструмент выключен: общий серверный механизм не готов. Причина указана в tools/list." : "Запрос отклонён сервером Ленканбана.",
      requestId, retryable: !error.disabled && ["DEPENDENCY_UNAVAILABLE", "RATE_LIMITED", "STALE_VERSION", "IDENTITY_CHANGED", "INVALID_MOVE_NEIGHBORS", "INTERNAL_ERROR"].includes(error.code),
      retryAfterSec: error.retryAfterSec } } };
}
