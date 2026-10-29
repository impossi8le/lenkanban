-- Durable business history and retry receipts, independent of telemetry TTL.
CREATE TABLE "OrganizationState" (
  "id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "OrganizationState_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "OrganizationOperation" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "operationId" UUID NOT NULL,
  "operation" TEXT NOT NULL,
  "targetKind" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "expectedVersion" INTEGER NOT NULL,
  "committedVersion" INTEGER NOT NULL,
  "changed" BOOLEAN NOT NULL,
  "before" JSONB NOT NULL,
  "after" JSONB NOT NULL,
  "result" JSONB NOT NULL,
  "committedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationOperation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrganizationOperation_committedAt_id_idx" ON "OrganizationOperation"("committedAt", "id");
CREATE UNIQUE INDEX "OrganizationOperation_actorId_operationId_key" ON "OrganizationOperation"("actorId", "operationId");
