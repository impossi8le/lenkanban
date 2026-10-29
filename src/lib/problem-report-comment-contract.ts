import { validCorrelationId } from "./telemetry-sanitize";

export const PROBLEM_REPORT_COMMENT_MAX = 2000;
export function parseProblemReportComment(value: unknown): { comment: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "comment") return null;
  const comment = (value as { comment?: unknown }).comment;
  if (typeof comment !== "string" || !comment.trim() || comment.length > PROBLEM_REPORT_COMMENT_MAX || comment.includes("\0")) return null;
  return { comment };
}
export function problemReportId(value: unknown): string | null {
  return validCorrelationId(value) ? (value as string).toLowerCase() : null;
}
