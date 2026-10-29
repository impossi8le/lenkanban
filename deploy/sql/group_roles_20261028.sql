-- Additive only. Apply inside the reviewed release transaction after exact
-- baseline/backup/restore guards. No ledger replay, seed or existing-row writes.
CREATE TABLE "GroupPrivilegeAssignment" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "scopeKind" TEXT NOT NULL,
  "departmentId" TEXT,
  "projectId" TEXT,
  CONSTRAINT "GroupPrivilegeAssignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GroupPrivilegeAssignment_scope_shape_check" CHECK (
    ("scopeKind" = 'organization' AND "departmentId" IS NULL AND "projectId" IS NULL)
    OR ("scopeKind" = 'department' AND "departmentId" IS NOT NULL AND "projectId" IS NULL)
    OR ("scopeKind" = 'board' AND "departmentId" IS NULL AND "projectId" IS NOT NULL)
  ),
  CONSTRAINT "GroupPrivilegeAssignment_identifiers_check" CHECK (
    "groupId" ~ '^[A-Za-z0-9_-]{1,128}$' AND "profileId" ~ '^[A-Za-z0-9_-]{1,128}$'
    AND ("departmentId" IS NULL OR "departmentId" ~ '^[A-Za-z0-9_-]{1,128}$')
    AND ("projectId" IS NULL OR "projectId" ~ '^[A-Za-z0-9_-]{1,128}$')
  ),
  -- Same compact JSON array as groupPrivilegeAssignmentId, without pgcrypto.
  CONSTRAINT "GroupPrivilegeAssignment_identity_check" CHECK (
    "id" = encode(sha256(convert_to(
      '["group",' || to_json("groupId")::text || ',' || to_json("profileId")::text || ',' ||
      to_json("scopeKind")::text || ',' || coalesce(to_json("departmentId")::text, 'null') || ',' ||
      coalesce(to_json("projectId")::text, 'null') || ']', 'UTF8')), 'hex')
  ),
  CONSTRAINT "GroupPrivilegeAssignment_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ResponsibleGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "GroupPrivilegeAssignment_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PrivilegeProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "GroupPrivilegeAssignment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "GroupPrivilegeAssignment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "GroupPrivilegeAssignment_groupId_idx" ON "GroupPrivilegeAssignment"("groupId");
CREATE INDEX "GroupPrivilegeAssignment_profileId_idx" ON "GroupPrivilegeAssignment"("profileId");
CREATE INDEX "GroupPrivilegeAssignment_departmentId_idx" ON "GroupPrivilegeAssignment"("departmentId");
CREATE INDEX "GroupPrivilegeAssignment_projectId_idx" ON "GroupPrivilegeAssignment"("projectId");
