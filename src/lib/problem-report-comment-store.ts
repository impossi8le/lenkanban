import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "./prisma";
import { TELEMETRY_RETENTION_MS } from "./telemetry/http";
import { parseProblemReportComment, problemReportId } from "./problem-report-comment-contract";

export class ProblemReportCommentError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "ProblemReportCommentError";
  }
}

/** No raw DB exception or cause may escape this boundary: it can contain text. */
export async function saveProblemReportComment(actorKey: string, reportId: string, comment: string, db: Pick<PrismaClient, "$transaction"> = prisma, now = new Date()): Promise<{ reportId: string }> {
  if (problemReportId(reportId) !== reportId || !parseProblemReportComment({ comment }) || !actorKey) throw new ProblemReportCommentError(400, "PROBLEM_REPORT_COMMENT_INVALID");
  try {
    return await db.$transaction(async tx => {
      const anchors = await tx.telemetryEvent.findMany({
        where: { actorKey, errorId: reportId, event: "client.problem.reported", source: "client", trust: "client_reported", category: "diagnostic", receivedAt: { gte: new Date(now.getTime() - TELEMETRY_RETENTION_MS) } },
        select: { id: true }, take: 2,
      });
      if (anchors.length === 0) throw new ProblemReportCommentError(404, "PROBLEM_REPORT_NOT_FOUND");
      if (anchors.length !== 1) throw new ProblemReportCommentError(409, "PROBLEM_REPORT_ID_CONFLICT");
      const eventId = anchors[0].id;
      await tx.$executeRaw(Prisma.sql`INSERT INTO "ProblemReportComment" ("reportId", "telemetryEventId", "comment") VALUES (${reportId}::uuid, ${eventId}, ${comment}) ON CONFLICT ("reportId") DO NOTHING`);
      const rows = await tx.$queryRaw<Array<{ comment: string }>>(Prisma.sql`SELECT "comment" FROM "ProblemReportComment" WHERE "reportId" = ${reportId}::uuid AND "telemetryEventId" = ${eventId}`);
      if (rows.length !== 1 || rows[0].comment !== comment) throw new ProblemReportCommentError(409, "PROBLEM_REPORT_COMMENT_CONFLICT");
      return { reportId };
    });
  } catch (error) {
    if (error instanceof ProblemReportCommentError) throw error;
    throw new ProblemReportCommentError(503, "PROBLEM_REPORT_COMMENT_UNAVAILABLE");
  }
}

/** Only the existing guarded global-admin report reader calls this function. */
export async function readProblemReportComment(eventId: string, reportId: string, db: Pick<PrismaClient, "$queryRaw"> = prisma): Promise<string | undefined> {
  try {
    const rows = await db.$queryRaw<Array<{ comment: string }>>(Prisma.sql`SELECT "comment" FROM "ProblemReportComment" WHERE "reportId" = ${reportId}::uuid AND "telemetryEventId" = ${eventId}`);
    return rows.length === 1 && parseProblemReportComment(rows[0]) ? rows[0].comment : undefined;
  } catch {
    throw new ProblemReportCommentError(503, "PROBLEM_REPORT_COMMENT_UNAVAILABLE");
  }
}
