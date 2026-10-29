import { NextResponse } from "next/server";
import type { ZodError } from "zod";

export type ApiErrorBody = {
  error: string;
  message?: string;
  details?: unknown;
};

export function jsonError(status: number, error: string, message?: string, details?: unknown) {
  return NextResponse.json(
    {
      error,
      ...(message ? { message } : {}),
      ...(details ? { details } : {}),
    } satisfies ApiErrorBody,
    { status }
  );
}

export function invalidJson() {
  return jsonError(400, "InvalidJSON");
}

export function validationError(error: ZodError) {
  return jsonError(
    422,
    "ValidationError",
    undefined,
    error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
      code: i.code,
    }))
  );
}

export function unauthorized() {
  return jsonError(401, "Unauthorized");
}

export function notFound() {
  return jsonError(404, "NotFound");
}

export function conflict(error: string, message?: string) {
  return jsonError(409, error, message);
}

export function forbidden(message?: string) {
  return jsonError(403, "Forbidden", message);
}

export function badRequest(message?: string, details?: unknown) {
  return jsonError(400, "BadRequest", message, details);
}

export function internalError(message?: string) {
  return jsonError(500, "InternalError", message);
}
