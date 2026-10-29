import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createProjectSchema } from "@/lib/validators";
import { ValidationError } from "@/lib/errors";
import { normalizeOrganizationApplicantPolicy } from "@/lib/organization-command";
import type { OrganizationApplicantPolicy } from "@/lib/organization-contract";
import { createOrganizationService } from "@/lib/organization";
import { ORGANIZATION_STATE_ID } from "@/lib/organization-command";
import { decodeLifecycleColumnMap, validateLifecycleColumnTargets, type LifecycleColumnMap } from "@/lib/task-request-columns";

/**
 * Shared board schemas and DTOs. Plain POST uses createAuditedBoard; the legacy
 * template creator below retains its separate compatibility contract.
 */

export const boardAccessProfileSchema = z.object({
  allEmployees: z.boolean(),
  userIds: z.array(z.string()).max(20),
  departmentIds: z.array(z.string()).max(20),
  groupIds: z.array(z.string()).max(20),
});

export const boardDepartmentSchema = z.string().trim().min(1).max(128);

export const boardCreationSchema = createProjectSchema.extend({
  departmentId: boardDepartmentSchema,
  operationId: z.string().uuid().optional(),
  accessProfile: boardAccessProfileSchema.nullable().optional(),
});

/** Template compatibility is separate from the required legacy POST owner. */
export const templateBoardCreationSchema = z.object({
  projectName: createProjectSchema.shape.name,
  projectDescription: createProjectSchema.shape.description,
  departmentId: boardDepartmentSchema.nullable().optional(),
  accessProfile: boardAccessProfileSchema.nullable().optional(),
});

export const boardColumnsSchema = z.array(z.object({
  id: z.string().min(1).optional(),
  name: z.string(),
  color: z.string(),
  position: z.number().int().min(-2147483648).max(2147483647),
  workflowKey: z.string(),
}));

export const boardTagsSchema = z.array(z.object({ name: z.string(), color: z.string() }));

export type BoardColumnInput = z.infer<typeof boardColumnsSchema>[number];
export type BoardTagInput = z.infer<typeof boardTagsSchema>[number];

export type CreatedBoard = Prisma.ProjectGetPayload<{
  include: { columns: true; tags: true };
}>;

/**
 * `workflowKey` is the column identifier: task status is derived from it and
 * (projectId, workflowKey) is unique. `name` is only the displayed label, so it
 * is localized while the keys stay stable for existing boards and filters.
 */
export { DEFAULT_BOARD_COLUMNS } from "@/lib/request-board-columns";
import { DEFAULT_BOARD_COLUMNS } from "@/lib/request-board-columns";

/** Normalizes the closed access profile shape; null means "not configured". */
export function parseBoardAccessProfile(value: unknown): OrganizationApplicantPolicy | null {
  if (value === undefined || value === null) return null;
  try {
    return normalizeOrganizationApplicantPolicy(value);
  } catch {
    throw new ValidationError("Invalid board access profile");
  }
}

/** An active, acyclic department chain; archived or missing targets are rejected. */
async function requireActiveDepartmentChain(departmentId: string): Promise<void> {
  const seen = new Set<string>();
  let cursor: string | null = departmentId;
  while (cursor !== null) {
    if (seen.has(cursor) || seen.size >= 1000) throw new ValidationError("Invalid department");
    seen.add(cursor);
    const row: { parentId: string | null; archivedAt: Date | null } | null =
      await prisma.department.findUnique({
        where: { id: cursor },
        select: { parentId: true, archivedAt: true },
      });
    if (!row || row.archivedAt !== null) throw new ValidationError("Invalid department");
    cursor = row.parentId;
  }
}

/** Access-profile subjects must exist; department/group targets must be active. */
async function requireAccessProfileTargets(policy: OrganizationApplicantPolicy, database: Pick<Prisma.TransactionClient, "user" | "department" | "responsibleGroup"> = prisma): Promise<void> {
  for (const userId of policy.userIds) {
    const row = await database.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!row) throw new ValidationError("Invalid access profile subject");
  }
  for (const departmentId of policy.departmentIds) {
    const row = await database.department.findUnique({
      where: { id: departmentId },
      select: { archivedAt: true },
    });
    if (!row || row.archivedAt !== null) throw new ValidationError("Invalid access profile department");
  }
  for (const groupId of policy.groupIds) {
    const row = await database.responsibleGroup.findUnique({
      where: { id: groupId },
      select: { archivedAt: true },
    });
    if (!row || row.archivedAt !== null) throw new ValidationError("Invalid access profile group");
  }
}

export interface CreateBoardInput {
  lifecycleColumnMap?: LifecycleColumnMap;
  actorId: string;
  name: string;
  description: string | null;
  departmentId: string | null;
  accessProfile: OrganizationApplicantPolicy | null;
  columns: readonly BoardColumnInput[];
  tags: readonly BoardTagInput[];
}

/**
 * Creates Project + ProjectColumn[] + Tag[] + ProjectApplicantPolicy in one
 * nested write. ownerId is always the authenticated session actor and never
 * contributes to the access profile preview or grants.
 */
export async function createBoard(input: CreateBoardInput): Promise<CreatedBoard> {
  if (input.lifecycleColumnMap !== undefined) {
    const map = decodeLifecycleColumnMap(input.lifecycleColumnMap);
    if (!map) throw new ValidationError("Invalid lifecycle columns");
    validateLifecycleColumnTargets(map, input.columns.map(column => ({ id: column.id ?? "", projectId: "new-board", workflowKey: column.workflowKey })), "new-board");
  }
  if (input.departmentId !== null) await requireActiveDepartmentChain(input.departmentId);
  if (input.accessProfile !== null) await requireAccessProfileTargets(input.accessProfile);

  return prisma.project.create({
    data: {
      name: input.name,
      description: input.description,
      ownerId: input.actorId,
      ...(input.lifecycleColumnMap ? { lifecycleColumnMap: input.lifecycleColumnMap } : {}),
      ...(input.departmentId !== null ? { departmentId: input.departmentId } : {}),
      columns: { create: input.columns.map(column => ({ ...column })) },
      tags: { create: input.tags.map(tag => ({ ...tag })) },
      ...(input.accessProfile !== null
        ? { applicantPolicyConfig: { create: { policy: input.accessProfile } } }
        : {}),
    },
    include: { columns: { orderBy: { position: "asc" } }, tags: true },
  });
}

/** The legacy DTO and supplemental fields share the audited command transaction. */
export async function createAuditedBoard(input: Omit<CreateBoardInput, "columns" | "tags" | "departmentId"> & {
  departmentId: string; operationId?: string;
}): Promise<CreatedBoard> {
  const operationId = (input.operationId ?? randomUUID()).toLowerCase();
  return prisma.$transaction(async tx => {
    // Read the current version under the same lock as all organization writers.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"organization-topology-v1"}, 0))::text AS locked`;
    const receipt = await tx.organizationOperation.findUnique({
      where: { actorId_operationId: { actorId: input.actorId, operationId } },
    });
    const state = await tx.organizationState.findUnique({ where: { id: ORGANIZATION_STATE_ID } });
    if (!receipt && input.accessProfile !== null) await requireAccessProfileTargets(input.accessProfile, tx);
    const service = createOrganizationService({ $transaction: (async (run: (client: Prisma.TransactionClient) => Promise<unknown>) => run(tx)) as typeof prisma.$transaction });
    const command = await service.createBoard({
      actorId: input.actorId, operationId, expectedVersion: receipt?.expectedVersion ?? state?.version ?? 0,
      name: input.name, departmentId: input.departmentId, responsibleGroupId: null,
    });
    if (!command.replayed) {
      await tx.project.update({ where: { id: command.result.id }, data: {
        description: input.description,
        ...(input.accessProfile !== null ? { applicantPolicyConfig: { create: { policy: input.accessProfile } } } : {}),
      } });
    }
    return tx.project.findUniqueOrThrow({ where: { id: command.result.id },
      include: { columns: { orderBy: { position: "asc" } }, tags: true } });
  });
}
