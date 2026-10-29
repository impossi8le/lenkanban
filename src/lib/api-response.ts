import { NextResponse } from "next/server";
import { ZodError } from "zod";

/**
 * Standard API response format
 */

export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    hasMore?: boolean;
    [key: string]: unknown;
  };
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Create a standardized success response
 */
export function apiSuccess<T>(
  data: T,
  meta?: ApiSuccessResponse<T>["meta"],
  status = 200
): NextResponse<ApiSuccessResponse<T>> {
  return NextResponse.json(
    {
      success: true,
      data,
      ...(meta && { meta }),
    },
    { status }
  );
}

/**
 * Create a standardized error response
 */
export function apiError(
  code: string,
  message: string,
  details?: unknown,
  status = 400
): NextResponse<ApiErrorResponse> {
  return NextResponse.json(
    {
      success: false,
      error: {
        code,
        message,
        details,
      },
    },
    { status }
  );
}

/**
 * Common error responses
 */
export function apiUnauthorized(message = "Unauthorized"): NextResponse<ApiErrorResponse> {
  return apiError("UNAUTHORIZED", message, undefined, 401);
}

export function apiForbidden(message = "Forbidden"): NextResponse<ApiErrorResponse> {
  return apiError("FORBIDDEN", message, undefined, 403);
}

export function apiNotFound(message = "Resource not found"): NextResponse<ApiErrorResponse> {
  return apiError("NOT_FOUND", message, undefined, 404);
}

export function apiBadRequest(message: string, details?: unknown): NextResponse<ApiErrorResponse> {
  return apiError("BAD_REQUEST", message, details, 400);
}

export function apiConflict(message: string, details?: unknown): NextResponse<ApiErrorResponse> {
  return apiError("CONFLICT", message, details, 409);
}

export function apiValidationError(error: ZodError): NextResponse<ApiErrorResponse> {
  return apiError(
    "VALIDATION_ERROR",
    "Validation failed",
    error.issues.map((e) => ({
      path: e.path.join("."),
      message: e.message,
    })),
    422
  );
}

export function apiInvalidJson(): NextResponse<ApiErrorResponse> {
  return apiError("INVALID_JSON", "Invalid JSON in request body", undefined, 400);
}

export function apiRateLimit(retryAfter: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests",
        details: { retryAfter },
      },
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
      },
    }
  );
}

export function apiInternalError(message = "Internal server error"): NextResponse<ApiErrorResponse> {
  return apiError("INTERNAL_ERROR", message, undefined, 500);
}
