-- Additive and repeatable: operators may validate this DDL twice on the isolated
-- test database before deployment. Existing tasks retain NULL importKey.
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "importKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Task_importKey_key" ON "Task"("importKey");

CREATE TABLE IF NOT EXISTS "MailImportBatch" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MailImportBatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MailImportBatch_batchId_key" ON "MailImportBatch"("batchId");
CREATE INDEX IF NOT EXISTS "MailImportBatch_createdBy_createdAt_idx" ON "MailImportBatch"("createdBy", "createdAt");
