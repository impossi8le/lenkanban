-- Rollback for the additive organization migrations:
--   20261020220000_organization_foundation
--   20261020230000_organization_commands
--
-- Scope and safety:
--   * Only organization metadata is removed. Task, Activity, ProjectMember and
--     all legacy Project/User columns are kept.
--   * Run only after the application code that writes these relations has been
--     rolled back; otherwise the API will fail on missing tables/columns.
--   * Order is child -> parent: drop dependent foreign keys and Project/User
--     columns before dropping Department, so no FK blocks the DROP TABLE.
--   * If later migrations that reference Department/ResponsibleGroup are
--     applied (for example 20261021060000_scoped_privileges), roll those back
--     first; this script only reverses the two #15 organization migrations.
--   * This file is a prepared artifact. It has NOT been executed against a real
--     database in this task; apply it only on an approved environment.

ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_responsibleGroupId_fkey";
ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_departmentId_fkey";
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_primaryDepartmentId_fkey";
ALTER TABLE "Department" DROP CONSTRAINT IF EXISTS "Department_leaderId_fkey";
ALTER TABLE "Department" DROP CONSTRAINT IF EXISTS "Department_parentId_fkey";
ALTER TABLE "ResponsibleGroupMember" DROP CONSTRAINT IF EXISTS "ResponsibleGroupMember_userId_fkey";
ALTER TABLE "ResponsibleGroupMember" DROP CONSTRAINT IF EXISTS "ResponsibleGroupMember_groupId_fkey";

DROP TABLE IF EXISTS "OrganizationOperation";
DROP TABLE IF EXISTS "OrganizationState";

ALTER TABLE "Project" DROP COLUMN IF EXISTS "responsibleGroupId", DROP COLUMN IF EXISTS "departmentId";
ALTER TABLE "User" DROP COLUMN IF EXISTS "primaryDepartmentId";

DROP TABLE IF EXISTS "ResponsibleGroupMember";
DROP TABLE IF EXISTS "ResponsibleGroup";
DROP TABLE IF EXISTS "Department";
