import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import techSupport from "../../prisma/templates/tech-support.json";
import { loadProjectTemplates, readProjectTemplates } from "./project-template-loader";

const directories: string[] = [];
async function fixtureDirectory(files: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "lenkanban-template-test-"));
  directories.push(directory);
  for (const [file, data] of Object.entries(files)) {
    await writeFile(join(directory, file), JSON.stringify(data));
  }
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

function databaseMock() {
  type SeedRecord = Awaited<ReturnType<typeof readProjectTemplates>>[number] & { createdById: string };
  const records = new Map<string, SeedRecord>();
  const upsert = vi.fn(async ({ where, create, update }: {
    where: { id: string };
    create: SeedRecord;
    update: Omit<SeedRecord, "id" | "createdById">;
  }) => {
    const existing = records.get(where.id);
    records.set(where.id, existing ? { ...existing, ...update } : create);
    return records.get(where.id);
  });
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) => {
    await callback({ projectTemplate: { upsert } });
  });
  return {
    database: { $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">,
    records, upsert, transaction,
  };
}

describe("built-in project template loader (mock database)", () => {
  it("reads the single support JSON file and prepares the existing templateData format", async () => {
    const templates = await readProjectTemplates();
    expect(templates.map(template => template.templateData.key).sort()).toEqual(["tech-support"]);
    for (const template of templates) {
      const source = JSON.parse(await readFile(resolve(
        "prisma/templates", `${template.templateData.key}.json`,
      ), "utf8")) as typeof techSupport;
      expect(template.id).toBe(`builtin-project-template-${template.templateData.key}`);
      expect(template.templateData.availability).toBe("organization");
      expect(template.templateData.descriptionHint).toBe(source.descriptionHint);
      expect(template.templateData.visibility).toMatchObject({ enforced: false, declaredOnly: true });
      expect(template.templateData.columns).toEqual(source.columns.map(column => ({
        ...column, color: expect.stringMatching(/^#[0-9a-f]{6}$/),
        workflowKey: column.workflowKey ?? "CUSTOM",
      })));
      expect(template.templateData.columns.filter(column => column.final)).toEqual([
        expect.objectContaining({ position: source.columns.length - 1, workflowKey: "DONE" }),
      ]);
      for (const column of template.templateData.columns) expect(column.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("upserts one stable record on repeated runs, updating data without changing the creator", async () => {
    const { database, records, upsert, transaction } = databaseMock();
    expect(await loadProjectTemplates(database, "seed-user")).toBe(1);
    expect(records.size).toBe(1);
    records.get("builtin-project-template-tech-support")!.name = "Outdated name";
    expect(await loadProjectTemplates(database, "another-seed-user")).toBe(1);
    expect(records.size).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(records.get("builtin-project-template-tech-support")).toMatchObject({
      name: techSupport.name, createdById: "seed-user",
      templateData: expect.objectContaining({ descriptionHint: techSupport.descriptionHint }),
    });
  });

  it("rejects an invalid template before opening a write transaction", async () => {
    const directory = await fixtureDirectory({
      "a-valid.json": techSupport,
      "z-invalid.json": { ...techSupport, key: "invalid", columns: [] },
    });
    const { database, transaction, upsert } = databaseMock();
    await expect(loadProjectTemplates(database, "seed-user", directory)).rejects.toThrow("PROJECT_TEMPLATE_INVALID");
    expect(transaction).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects duplicate keys across files without writing", async () => {
    const directory = await fixtureDirectory({ "one.json": techSupport, "two.json": techSupport });
    const { database, transaction } = databaseMock();
    await expect(loadProjectTemplates(database, "seed-user", directory)).rejects.toThrow("PROJECT_TEMPLATE_SET_INVALID");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an empty directory", async () => {
    const directory = await fixtureDirectory({});
    await expect(readProjectTemplates(directory)).rejects.toThrow("PROJECT_TEMPLATE_SET_INVALID");
  });

  it("rejects a valid but retired process preset without writing", async () => {
    const directory = await fixtureDirectory({ "retired.json": { ...techSupport, key: "it-requests" } });
    const { database, transaction } = databaseMock();
    await expect(loadProjectTemplates(database, "seed-user", directory)).rejects.toThrow("PROJECT_TEMPLATE_CATALOG_INVALID");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with a fixed error without its contents", async () => {
    const directory = await fixtureDirectory({});
    await writeFile(join(directory, "bad.json"), '{"synthetic-private-sentinel":');
    await expect(readProjectTemplates(directory)).rejects.toThrow(/^PROJECT_TEMPLATE_READ_FAILED$/);
  });

  it("rejects a final column that cannot be represented by the existing DONE workflow", async () => {
    const directory = await fixtureDirectory({ "bad.json": {
      ...techSupport,
      columns: techSupport.columns.map(column => column.final ? { ...column, workflowKey: null } : column),
    } });
    await expect(readProjectTemplates(directory)).rejects.toThrow("PROJECT_TEMPLATE_FINAL_WORKFLOW_INVALID");
  });
});
