-- Additive demo-only preparation. Apply only after the owning runtime/DB guard.
CREATE TABLE "TaskViewReceipt" (
 "taskId" TEXT NOT NULL REFERENCES "Task"("id") ON DELETE CASCADE,
 "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "snapshotHash" TEXT NOT NULL CHECK ("snapshotHash" ~ '^[a-f0-9]{64}$'),
 "viewedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 "observedAt" TIMESTAMPTZ NOT NULL,
 PRIMARY KEY ("taskId", "userId")
);
CREATE INDEX "TaskViewReceipt_userId_idx" ON "TaskViewReceipt" ("userId");
