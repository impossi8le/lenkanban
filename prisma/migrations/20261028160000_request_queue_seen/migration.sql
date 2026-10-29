-- Additive only: existing requests remain epoch zero (viewed at launch).
ALTER TABLE "TaskRequest" ADD COLUMN "queueEpoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TaskRequest" ADD CONSTRAINT "TaskRequest_queueEpoch_nonnegative_check"
  CHECK ("queueEpoch" >= 0);

CREATE TABLE "TaskRequestQueueSeen" (
  "taskId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskRequestQueueSeen_pkey" PRIMARY KEY ("taskId", "userId"),
  CONSTRAINT "TaskRequestQueueSeen_taskId_fkey" FOREIGN KEY ("taskId")
    REFERENCES "TaskRequest"("taskId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskRequestQueueSeen_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TaskRequestQueueSeen_userId_idx" ON "TaskRequestQueueSeen"("userId");
