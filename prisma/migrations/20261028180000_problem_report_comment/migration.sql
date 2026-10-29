-- Explicit business content, separated from diagnostic events and breadcrumbs.
-- Parent cleanup deletes this row through the FK; no existing rows are changed.
CREATE TABLE "ProblemReportComment" (
    "reportId" UUID NOT NULL,
    "telemetryEventId" TEXT NOT NULL,
    "comment" VARCHAR(2000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProblemReportComment_pkey" PRIMARY KEY ("reportId"),
    CONSTRAINT "ProblemReportComment_comment_length" CHECK (char_length("comment") BETWEEN 1 AND 2000),
    CONSTRAINT "ProblemReportComment_telemetryEventId_fkey" FOREIGN KEY ("telemetryEventId") REFERENCES "TelemetryEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProblemReportComment_telemetryEventId_key" ON "ProblemReportComment"("telemetryEventId");
