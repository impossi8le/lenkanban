-- Additive organization metadata only. No legacy backfill or permission change.
ALTER TABLE "User" ADD COLUMN "primaryDepartmentId" TEXT;
ALTER TABLE "Project" ADD COLUMN "departmentId" TEXT, ADD COLUMN "responsibleGroupId" TEXT;

CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "leaderId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ResponsibleGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResponsibleGroup_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ResponsibleGroupMember" (
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResponsibleGroupMember_pkey" PRIMARY KEY ("groupId", "userId")
);
CREATE INDEX "Department_parentId_idx" ON "Department"("parentId");
CREATE INDEX "Department_leaderId_idx" ON "Department"("leaderId");
CREATE INDEX "ResponsibleGroupMember_userId_idx" ON "ResponsibleGroupMember"("userId");
CREATE INDEX "User_primaryDepartmentId_idx" ON "User"("primaryDepartmentId");
CREATE INDEX "Project_departmentId_idx" ON "Project"("departmentId");
CREATE INDEX "Project_responsibleGroupId_idx" ON "Project"("responsibleGroupId");
ALTER TABLE "User" ADD CONSTRAINT "User_primaryDepartmentId_fkey" FOREIGN KEY ("primaryDepartmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Department" ADD CONSTRAINT "Department_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Department" ADD CONSTRAINT "Department_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResponsibleGroupMember" ADD CONSTRAINT "ResponsibleGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ResponsibleGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResponsibleGroupMember" ADD CONSTRAINT "ResponsibleGroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_responsibleGroupId_fkey" FOREIGN KEY ("responsibleGroupId") REFERENCES "ResponsibleGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
