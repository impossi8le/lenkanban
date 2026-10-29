SET lock_timeout = '5s';
SET statement_timeout = '30s';
ALTER TABLE "ChatMessage"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "editedAt" TIMESTAMP(3),
  ADD COLUMN "deletedAt" TIMESTAMP(3);
