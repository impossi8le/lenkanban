-- Explicit closure and group leadership. No assignment or state backfill.
ALTER TYPE "TaskRequestState" ADD VALUE IF NOT EXISTS 'CLOSED';
ALTER TABLE "ResponsibleGroup" ADD COLUMN "leaderId" TEXT;
CREATE INDEX "ResponsibleGroup_leaderId_idx" ON "ResponsibleGroup"("leaderId");
ALTER TABLE "ResponsibleGroup" ADD CONSTRAINT "ResponsibleGroup_leaderId_fkey"
  FOREIGN KEY ("leaderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaskRequest" DROP CONSTRAINT "TaskRequest_executor_shape_check";
-- Cast to text: a newly added enum label cannot be used as an enum literal
-- until commit on PostgreSQL. The retained executor invariant stays strict.
ALTER TABLE "TaskRequest" ADD CONSTRAINT "TaskRequest_executor_shape_check" CHECK (
  ("state"::text IN ('DRAFT', 'SUBMITTED') AND "executorId" IS NULL)
  OR ("state"::text IN ('IN_PROGRESS', 'NEEDS_INFO', 'COMPLETED', 'CLOSED') AND "executorId" IS NOT NULL)
  OR "state"::text = 'CANCELLED'
);
