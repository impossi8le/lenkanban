import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Offline guard for the query-performance indexes.
 *
 * Reads `prisma/schema.prisma` and the migration SQL as text. It opens no
 * connection, runs no SQL and does not prove a plan improvement: it only proves
 * that the migration, the datamodel and the documented rollback agree, that no
 * index duplicates an existing one, and that the file stays non-destructive.
 */
const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const MIGRATION = "prisma/migrations/20261022120000_db_performance_indexes/migration.sql";
const BASELINE = "prisma/migrations/20260101000000_baseline/migration.sql";

const migration = read(MIGRATION);
const schema = read("prisma/schema.prisma");
const baseline = read(BASELINE);

type ExpectedIndex = {
  name: string;
  table: string;
  columns: string[];
  gin?: boolean;
  opclass?: string;
  /** Why this index exists — one line, mirrors the migration comment. */
  reason: string;
  /** The datamodel line that must produce it. */
  schemaPattern: RegExp;
};

const EXPECTED: ExpectedIndex[] = [
  {
    name: "Project_ownerId_idx",
    table: "Project",
    columns: ["ownerId"],
    reason: "project list scope OR[{ ownerId }, { members.some }]",
    schemaPattern: /^\s*@@index\(\[ownerId\]\)$/m,
  },
  {
    name: "Project_updatedAt_idx",
    table: "Project",
    columns: ["updatedAt"],
    reason: "project list ORDER BY updatedAt DESC (legacy list and dashboard top 6)",
    schemaPattern: /^\s*@@index\(\[updatedAt\]\)$/m,
  },
  {
    name: "Task_projectId_position_idx",
    table: "Task",
    columns: ["projectId", "position"],
    reason: "board list WHERE projectId = $1 ORDER BY position ASC",
    schemaPattern: /^\s*@@index\(\[projectId, position\]\)$/m,
  },
  {
    name: "Task_status_idx",
    table: "Task",
    columns: ["status"],
    reason: "analytics groupBy(status) and status counters",
    schemaPattern: /^\s*@@index\(\[status\]\)$/m,
  },
  {
    name: "Task_priority_idx",
    table: "Task",
    columns: ["priority"],
    reason: "analytics groupBy(priority)",
    schemaPattern: /^\s*@@index\(\[priority\]\)$/m,
  },
  {
    name: "Task_deadline_idx",
    table: "Task",
    columns: ["deadline"],
    reason: "overdue counters: status != 'DONE' AND deadline < now()",
    schemaPattern: /^\s*@@index\(\[deadline\]\)$/m,
  },
  {
    name: "User_name_gin_idx",
    table: "User",
    columns: ["name"],
    gin: true,
    opclass: "gin_trgm_ops",
    reason: "ILIKE '%q%' over name in /api/users and /api/admin/users",
    schemaPattern: /^\s*@@index\(\[name\(ops: raw\("gin_trgm_ops"\)\)\], type: Gin, map: "User_name_gin_idx"\)$/m,
  },
  {
    name: "User_email_gin_idx",
    table: "User",
    columns: ["email"],
    gin: true,
    opclass: "gin_trgm_ops",
    reason: "ILIKE '%q%' over email in /api/users and /api/admin/users",
    schemaPattern: /^\s*@@index\(\[email\(ops: raw\("gin_trgm_ops"\)\)\], type: Gin, map: "User_email_gin_idx"\)$/m,
  },
  {
    name: "User_createdAt_id_idx",
    table: "User",
    columns: ["createdAt", "id"],
    reason: "admin keyset ORDER BY createdAt DESC, id DESC",
    schemaPattern: /^\s*@@index\(\[createdAt, id\]\)$/m,
  },
];

type ParsedIndex = { name: string; table: string; gin: boolean; columns: string[] };

/**
 * Matches real statements only. The commented CONCURRENTLY guidance cannot
 * match because a quoted name must follow `CREATE INDEX` directly.
 */
function parseCreatedIndexes(sql: string): ParsedIndex[] {
  // B-tree statements have no space before `(`, GIN ones do; allow both.
  const pattern = /CREATE INDEX "([^"]+)" ON "([^"]+)"(?: USING (GIN))?\s*\(([^)]*)\);/g;
  return [...sql.matchAll(pattern)].map((match) => ({
    name: match[1],
    table: match[2],
    gin: match[3] === "GIN",
    // Drop a trailing operator class ("email" gin_trgm_ops) before comparing.
    columns: match[4]
      .split(",")
      .map((column) => column.trim().split(/\s+/)[0].replace(/^"|"$/g, "")),
  }));
}

/** Splits the file into executable SQL and comment lines. */
function splitSqlAndComments(sql: string) {
  const lines = sql.split(/\r?\n/);
  const comments = lines.filter((line) => line.trimStart().startsWith("--"));
  const statements = lines.filter((line) => !line.trimStart().startsWith("--"));
  return { comments, statements: statements.join("\n") };
}

const created = parseCreatedIndexes(migration);
const { comments, statements } = splitSqlAndComments(migration);

/** Model name -> field names, parsed from the datamodel. */
function parseModels(datamodel: string): Map<string, Set<string>> {
  const models = new Map<string, Set<string>>();
  const modelPattern = /^model (\w+) \{([\s\S]*?)^\}/gm;
  for (const match of datamodel.matchAll(modelPattern)) {
    const fields = new Set<string>();
    for (const rawLine of match[2].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
      const field = /^(\w+)\s+\S/.exec(line);
      if (field) fields.add(field[1]);
    }
    models.set(match[1], fields);
  }
  return models;
}

const models = parseModels(schema);
const baselineNames = new Set(parseCreatedIndexes(baseline).map((index) => index.name));

describe("performance index migration stays additive and reversible (offline SQL review)", () => {
  it("changes no rows and alters no table", () => {
    expect(statements).not.toMatch(/\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\b/i);
    expect(statements).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(statements).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
    // CREATE INDEX / CREATE EXTENSION are the only statements this file may run.
    const createKeywords = [...statements.matchAll(/^CREATE\s+([A-Z]+)/gim)].map((match) => match[1].toUpperCase());
    expect(createKeywords.length).toBeGreaterThan(0);
    expect(createKeywords.every((keyword) => keyword === "INDEX" || keyword === "EXTENSION")).toBe(true);
  });

  it("creates exactly the nine reviewed indexes", () => {
    expect(created).toHaveLength(EXPECTED.length);
    expect(created.map((index) => index.name).sort()).toEqual(EXPECTED.map((index) => index.name).sort());
  });

  it("names every index once", () => {
    expect(new Set(created.map((index) => index.name)).size).toBe(created.length);
  });

  it("does not recreate an index that the baseline already has", () => {
    for (const index of created) {
      expect(baselineNames.has(index.name), `${index.name} already exists in the baseline`).toBe(false);
    }
  });

  it("ships no GIN index on ChatMessage.readBy, which no query can use", () => {
    // Both read sites negate the jsonb existence operator (`NOT ("readBy" ? $1)`)
    // and PostgreSQL has no negated GIN operator class, so the index could not
    // serve either query and would only add write cost. Revisit if a positive
    // `"readBy" ? $1` appears, or when read receipts move to their own table.
    expect(created.some((index) => index.table === "ChatMessage")).toBe(false);
    expect(schema).not.toMatch(/@@index\(\[readBy/);
    // Keep the evidence beside the decision instead of only in a chat log.
    expect(comments.join("\n")).toContain("src/app/api/tasks/route.ts:180");
    expect(comments.join("\n")).toContain("src/app/api/tasks/[id]/messages/read/route.ts:59");
  });

  it.each(EXPECTED)("declares $name in the datamodel, the SQL and the rollback", (expected) => {
    expect(schema).toMatch(expected.schemaPattern);
    expect(migration).toContain(`CREATE INDEX "${expected.name}"`);
    expect(comments.join("\n")).toContain(`DROP INDEX IF EXISTS "${expected.name}";`);
  });

  it.each(EXPECTED)("targets an existing table and existing columns for $name", (expected) => {
    const parsed = created.find((index) => index.name === expected.name);
    expect(parsed, `${expected.name} is missing from the migration`).toBeDefined();
    expect(parsed!.table).toBe(expected.table);
    expect(parsed!.columns).toEqual(expected.columns);

    const fields = models.get(expected.table);
    expect(fields, `model ${expected.table} not found in the datamodel`).toBeDefined();
    for (const column of expected.columns) {
      expect(fields!.has(column), `${expected.table}.${column} is not a field`).toBe(true);
    }
  });

  it.each(EXPECTED)("uses the operator class the query needs for $name", (expected) => {
    const parsed = created.find((index) => index.name === expected.name)!;
    expect(parsed.gin).toBe(expected.gin === true);
    if (expected.opclass) {
      // `?` on jsonb requires jsonb_ops; ILIKE '%q%' requires a trigram class.
      expect(migration).toMatch(
        new RegExp(`CREATE INDEX "${expected.name}" ON "${expected.table}" USING GIN \\("${expected.columns[0]}" ${expected.opclass}\\);`),
      );
    }
  });

  it("guards the extension so a replay cannot fail on an existing pg_trgm", () => {
    expect(statements).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  });

  it("keeps CONCURRENTLY out of the executable body", () => {
    // Prisma wraps each migration file in a transaction, where CONCURRENTLY fails.
    expect(statements).not.toMatch(/CONCURRENTLY/i);
    expect(comments.join("\n")).toMatch(/CREATE INDEX CONCURRENTLY/);
  });

  it("documents how the manual CONCURRENTLY path is marked as applied", () => {
    expect(comments.join("\n")).toContain("prisma migrate resolve --applied 20261022120000_db_performance_indexes");
  });

  it("rolls back every index it creates, and nothing else", () => {
    const drops = [...comments.join("\n").matchAll(/DROP INDEX IF EXISTS "([^"]+)";/g)].map((match) => match[1]);
    expect(drops.sort()).toEqual(EXPECTED.map((index) => index.name).sort());
    // pg_trgm predates this migration and is shared, so the rollback keeps it.
    expect(comments.join("\n")).not.toMatch(/DROP EXTENSION/);
  });
});
