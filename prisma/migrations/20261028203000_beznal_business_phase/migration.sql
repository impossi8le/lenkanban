-- Nullable legacy state: no automatic invoice inference or executor rewriting.
ALTER TABLE "TaskRequest" ADD COLUMN "beznalPhase" TEXT;
ALTER TABLE "TaskRequest" ADD COLUMN "currentInvoiceUrl" TEXT;
ALTER TABLE "TaskRequest" ADD CONSTRAINT "TaskRequest_beznalPhase_check" CHECK ("beznalPhase" IS NULL OR "beznalPhase" IN ('WAITING','INVOICED'));
