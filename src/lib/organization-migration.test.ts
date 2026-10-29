import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Offline guard for issue #15 criterion 7: the organization schema is additive,
 * never backfills legacy rows, and has a prepared reverse migration. This reads
 * SQL files only; it is not a PostgreSQL migration or rollback execution.
 */
const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");
const foundation = read("prisma/migrations_legacy/20261020220000_organization_foundation/migration.sql");
const commands = read("prisma/migrations_legacy/20261020230000_organization_commands/migration.sql");
const rollback = read("prisma/migrations_legacy/20261020230000_organization_commands/ROLLBACK.sql");
const migrations = `${foundation}\n${commands}`;

describe("organization migrations stay additive and reversible (offline SQL review)", () => {
  it("contains no data backfill or destructive statement on existing rows", () => {
    expect(migrations).not.toMatch(/^\s*(UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\b/im);
    expect(migrations).not.toMatch(/ALTER TABLE "(ProjectMember|Task|Activity|Notification)"/i);
  });
  it("adds only nullable organizational columns to legacy User and Project", () => {
    expect(foundation).toContain('ADD COLUMN "primaryDepartmentId" TEXT');
    expect(foundation).toContain('ADD COLUMN "departmentId" TEXT');
    expect(foundation).toContain('ADD COLUMN "responsibleGroupId" TEXT');
    // Existing rows keep NULL, so no membership or access is inferred for them.
    expect(foundation).not.toMatch(/ADD COLUMN[^;]*NOT NULL/i);
    expect(foundation).not.toMatch(/ADD COLUMN[^;]*DEFAULT/i);
    expect(foundation).not.toContain('"ProjectMember"');
    expect(commands).not.toContain('"ProjectMember"');
  });
  it("creates separate organization tables without touching legacy membership tables", () => {
    for (const table of ["Department", "ResponsibleGroup", "ResponsibleGroupMember", "OrganizationState", "OrganizationOperation"]) {
      expect(migrations).toContain(`CREATE TABLE "${table}"`);
    }
    expect(migrations).not.toMatch(/ALTER TABLE "(ProjectMember|Task|Activity|Notification)"/i);
  });
  it("provides a rollback that drops every new table and column", () => {
    for (const table of ["OrganizationOperation", "OrganizationState", "ResponsibleGroupMember", "ResponsibleGroup", "Department"]) {
      expect(rollback).toContain(`DROP TABLE IF EXISTS "${table}";`);
    }
    for (const column of ["responsibleGroupId", "departmentId", "primaryDepartmentId"]) {
      expect(rollback).toContain(`DROP COLUMN IF EXISTS "${column}"`);
    }
  });
  it("keeps legacy tables in the rollback and drops dependents before Department", () => {
    expect(rollback).not.toMatch(/DROP TABLE IF EXISTS "(User|Project|ProjectMember|Task|Activity)"/i);
    const projectColumns = rollback.indexOf('ALTER TABLE "Project" DROP COLUMN');
    const userColumn = rollback.indexOf('ALTER TABLE "User" DROP COLUMN');
    const memberTable = rollback.indexOf('DROP TABLE IF EXISTS "ResponsibleGroupMember";');
    const groupTable = rollback.indexOf('DROP TABLE IF EXISTS "ResponsibleGroup";');
    const departmentTable = rollback.indexOf('DROP TABLE IF EXISTS "Department";');
    expect(projectColumns).toBeGreaterThan(-1);
    expect(userColumn).toBeGreaterThan(-1);
    expect(projectColumns).toBeLessThan(departmentTable);
    expect(userColumn).toBeLessThan(departmentTable);
    expect(memberTable).toBeLessThan(groupTable);
    expect(groupTable).toBeLessThan(departmentTable);
  });
});
