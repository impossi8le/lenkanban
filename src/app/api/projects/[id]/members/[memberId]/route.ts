import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { requireProjectMemberAdmin } from "@/lib/project-access";
import { emitProjectMembersUpdated, emitProjectMemberDeleted } from "@/socket/board-events";
import {
  apiSuccess,
  apiUnauthorized,
  apiNotFound,
  apiInvalidJson,
  apiValidationError,
  apiConflict,
  apiInternalError
} from "@/lib/api-response";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  role: z.enum(["MEMBER", "PROJECT_ADMIN"]),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string; memberId: string }> }) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) return apiValidationError(parsed.error);

  try {
    const actor = await requireApiUser(request);
    const params = await context.params;

    await requireProjectMemberAdmin(actor, params.id);

    const row = await prisma.projectMember.findFirst({
      where: { id: params.memberId, projectId: params.id },
      select: { id: true, userId: true },
    });
    if (!row) return apiNotFound();

    const project = await prisma.project.findUnique({
      where: { id: params.id },
      select: { ownerId: true },
    });

    // Don't allow changing owner's role via membership table.
    if (project?.ownerId && row.userId === project.ownerId) {
      return apiConflict("Нельзя изменить роль владельца проекта");
    }

    const updated = await prisma.projectMember.update({
      where: { id: row.id },
      data: { role: parsed.data.role },
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: { select: { id: true, email: true, name: true, avatarUrl: true } },
      },
    });

    // Emit real-time update to all connected clients
    emitProjectMembersUpdated(params.id, updated);

    return apiSuccess(updated);
  } catch (e) {
    if (e instanceof UnauthorizedError) return apiUnauthorized();
    if (String(e).includes("NotFound")) return apiNotFound();
    return apiInternalError("Не удалось обновить роль участника");
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; memberId: string }> }) {
  try {
    const actor = await requireApiUser(_request);
    const params = await context.params;

    await requireProjectMemberAdmin(actor, params.id);

    const row = await prisma.projectMember.findFirst({
      where: { id: params.memberId, projectId: params.id },
      select: { id: true, userId: true },
    });
    if (!row) return apiNotFound();

    const project = await prisma.project.findUnique({
      where: { id: params.id },
      select: { ownerId: true },
    });

    // Don't allow removing owner via membership table.
    if (project?.ownerId && row.userId === project.ownerId) {
      return apiConflict("Нельзя удалить владельца проекта");
    }

    await prisma.projectMember.delete({ where: { id: row.id } });

    // Emit real-time update to all connected clients
    emitProjectMemberDeleted(params.id, params.memberId);

    return new NextResponse(null, { status: 204 });
  } catch (e) {
    if (e instanceof UnauthorizedError) return apiUnauthorized();
    if (String(e).includes("NotFound")) return apiNotFound();
    return apiInternalError("Не удалось удалить участника проекта");
  }
}
