import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { validateTemplate, validateTemplateSet } from "../../prisma/templates/validate";
import { SUPPORT_TEMPLATE_KEY } from "./project-template-catalog";

interface ProcessTemplate extends Prisma.InputJsonObject {
  key: string;
  name: string;
  description: string;
  descriptionHint: string;
  visibility: Prisma.InputJsonObject;
  columns: Array<Prisma.InputJsonObject & {
    name: string;
    position: number;
    workflowKey?: string | null;
    final: boolean;
  }>;
}

const columnColors: Readonly<Record<string, string>> = {
  TODO: "#3b82f6",
  IN_PROGRESS: "#f59e0b",
  REVIEW: "#0ea5e9",
  DONE: "#10b981",
};

/** Read and validate the entire catalog before any database writes. */
export async function readProjectTemplates(
  directory = resolve(process.cwd(), "prisma/templates"),
) {
  const files = (await readdir(directory)).filter(file => file.endsWith(".json")).sort();
  const sources = await Promise.all(files.map(async source => {
    let data: unknown;
    try {
      data = JSON.parse(await readFile(join(directory, source), "utf8"));
    } catch {
      // Do not expose file contents, JSON parser snippets or filesystem errors.
      throw new Error("PROJECT_TEMPLATE_READ_FAILED");
    }
    if (validateTemplate(source, data).length > 0) {
      throw new Error("PROJECT_TEMPLATE_INVALID");
    }
    return { source, data };
  }));
  if (!validateTemplateSet(sources).ok) throw new Error("PROJECT_TEMPLATE_SET_INVALID");
  if (sources.length !== 1) throw new Error("PROJECT_TEMPLATE_CATALOG_INVALID");

  return sources.map(({ data }) => {
    // validateTemplate has established these fields on parsed JSON.
    const template = data as ProcessTemplate;
    if (template.key !== SUPPORT_TEMPLATE_KEY) throw new Error("PROJECT_TEMPLATE_CATALOG_INVALID");
    const finalColumn = template.columns.find(column => column.final);
    // ProjectColumn represents completion with DONE, not a separate final flag.
    if (finalColumn?.workflowKey !== "DONE" ||
      template.columns.some(column => !column.final && column.workflowKey === "DONE")) {
      throw new Error("PROJECT_TEMPLATE_FINAL_WORKFLOW_INVALID");
    }
    return {
      id: `builtin-project-template-${template.key}`,
      name: template.name,
      description: template.description,
      templateData: {
        ...template,
        availability: "organization",
        columns: template.columns.map(column => ({
          ...column,
          color: columnColors[column.workflowKey ?? ""] ?? "#6b7280",
          // A non-reserved key invokes the existing per-column key generator.
          workflowKey: column.workflowKey ?? "CUSTOM",
        })),
        tags: [],
      } satisfies Prisma.InputJsonObject,
    };
  });
}

/** Stable primary keys make repeated imports update the support template. */
export async function loadProjectTemplates(
  database: Pick<PrismaClient, "$transaction">,
  createdById: string,
  directory?: string,
) {
  const templates = await readProjectTemplates(directory);
  await database.$transaction(async tx => {
    for (const { id, ...data } of templates) {
      await tx.projectTemplate.upsert({
        where: { id },
        update: data,
        create: { id, ...data, createdById },
      });
    }
  });
  return templates.length;
}
