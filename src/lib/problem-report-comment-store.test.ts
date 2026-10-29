import { beforeEach, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
vi.mock("./prisma", () => ({ prisma: {} }));
import { ProblemReportCommentError, readProblemReportComment, saveProblemReportComment } from "./problem-report-comment-store";
import { parseProblemReportComment, problemReportId } from "./problem-report-comment-contract";

const id = "11111111-1111-4111-8111-111111111111";
const text = "Свой комментарий\n<script>synthetic_secret</script>";
const tx = { telemetryEvent: { findMany: vi.fn() }, $executeRaw: vi.fn(), $queryRaw: vi.fn() };
const db = { $transaction: vi.fn((callback: (arg: typeof tx) => unknown) => callback(tx)) } as unknown as Pick<PrismaClient, "$transaction">;
beforeEach(() => { vi.clearAllMocks(); tx.telemetryEvent.findMany.mockResolvedValue([{ id: "event-1" }]); tx.$executeRaw.mockResolvedValue(1); tx.$queryRaw.mockResolvedValue([{ comment: text }]); });

it("accepts only explicit nonempty text of at most 2000 UTF16 characters and a UUID", () => {
  expect(parseProblemReportComment({ comment: text })).toEqual({ comment: text });
  expect(parseProblemReportComment({ comment: "я".repeat(2000) })).not.toBeNull();
  for (const value of [{ comment: "я".repeat(2001) }, { comment: " " }, { comment: "a\0b" }, { comment: text, cookie: "secret" }, { comment: 2 }]) expect(parseProblemReportComment(value)).toBeNull();
  expect(problemReportId(id.toUpperCase())).toBe(id);
  expect(problemReportId("not-an-id")).toBeNull();
});
it("binds ownership to the committed manual report and parameterizes content outside telemetry", async () => {
  expect(await saveProblemReportComment("actor-key", id, text, db)).toEqual({ reportId: id });
  expect(tx.telemetryEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ actorKey: "actor-key", errorId: id, event: "client.problem.reported", source: "client", trust: "client_reported", category: "diagnostic", receivedAt: { gte: expect.any(Date) } }), take: 2 }));
  const query = tx.$executeRaw.mock.calls[0][0];
  expect(query.values).toEqual([id, "event-1", text]);
  expect(query.strings.join("")).not.toContain(text);
  expect(query.strings.join("")).toContain('ON CONFLICT ("reportId") DO NOTHING');
  expect(Object.keys(tx)).toEqual(["telemetryEvent", "$executeRaw", "$queryRaw"]);
});
it("acknowledges identical retries without changing the stored text", async () => {
  await saveProblemReportComment("actor-key", id, text, db);
  tx.$executeRaw.mockResolvedValue(0);
  expect(await saveProblemReportComment("actor-key", id, text, db)).toEqual({ reportId: id });
});
it("returns an opaque 404 for another actor or a missing/expired report without writing", async () => {
  tx.telemetryEvent.findMany.mockResolvedValue([]);
  await expect(saveProblemReportComment("other-actor", id, text, db)).rejects.toMatchObject({ status: 404, code: "PROBLEM_REPORT_NOT_FOUND" });
  expect(tx.$executeRaw).not.toHaveBeenCalled();
});
it("rejects ambiguous report anchors and a changed-body retry", async () => {
  tx.telemetryEvent.findMany.mockResolvedValueOnce([{ id: "one" }, { id: "two" }]);
  await expect(saveProblemReportComment("actor-key", id, text, db)).rejects.toMatchObject({ status: 409 });
  tx.$queryRaw.mockResolvedValueOnce([{ comment: "original" }]);
  await expect(saveProblemReportComment("actor-key", id, text, db)).rejects.toMatchObject({ status: 409, code: "PROBLEM_REPORT_COMMENT_CONFLICT" });
});
it("discards raw database query text/cause on write and read failures", async () => {
  const raw = Object.assign(new Error(text), { cause: { query: text } });
  tx.$executeRaw.mockRejectedValueOnce(raw);
  let failed: unknown;
  try { await saveProblemReportComment("actor-key", id, text, db); } catch (error) { failed = error; }
  expect(failed).toBeInstanceOf(ProblemReportCommentError);
  expect(JSON.stringify(failed)).not.toContain("synthetic_secret");
  expect((failed as Error).message).toBe("PROBLEM_REPORT_COMMENT_UNAVAILABLE");
  expect((failed as Error).cause).toBeUndefined();
  const reader = { $queryRaw: vi.fn().mockRejectedValue(raw) } as unknown as Pick<PrismaClient, "$queryRaw">;
  await expect(readProblemReportComment("event-1", id, reader)).rejects.toMatchObject({ status: 503, message: "PROBLEM_REPORT_COMMENT_UNAVAILABLE" });
});
it("returns text only for the exact anchor selected by the guarded report reader", async () => {
  const reader = { $queryRaw: vi.fn().mockResolvedValue([{ comment: text }]) };
  expect(await readProblemReportComment("event-1", id, reader as unknown as Pick<PrismaClient, "$queryRaw">)).toBe(text);
  expect(reader.$queryRaw.mock.calls[0][0].values).toEqual([id, "event-1"]);
});
