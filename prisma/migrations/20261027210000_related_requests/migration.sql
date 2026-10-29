SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TABLE "TaskRelation" (
    "leftTaskId" TEXT NOT NULL,
    "rightTaskId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskRelation_pkey" PRIMARY KEY ("leftTaskId", "rightTaskId"),
    CONSTRAINT "TaskRelation_order_check" CHECK ("leftTaskId" COLLATE "C" < "rightTaskId" COLLATE "C"),
    CONSTRAINT "TaskRelation_leftTaskId_fkey" FOREIGN KEY ("leftTaskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskRelation_rightTaskId_fkey" FOREIGN KEY ("rightTaskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TaskRelation_rightTaskId_idx" ON "TaskRelation"("rightTaskId");
