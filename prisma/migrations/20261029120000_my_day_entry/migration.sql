CREATE TABLE "MyDayEntry" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "text" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastOperationId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MyDayEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MyDayEntry_version_check" CHECK ("version" >= 1),
    CONSTRAINT "MyDayEntry_text_length_check" CHECK (char_length("text") <= 50000)
);
CREATE UNIQUE INDEX "MyDayEntry_ownerId_date_key" ON "MyDayEntry"("ownerId", "date");
ALTER TABLE "MyDayEntry" ADD CONSTRAINT "MyDayEntry_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
