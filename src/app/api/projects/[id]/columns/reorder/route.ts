import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { requireApiUser } from "@/lib/require-api-user";
import { emitColumnsReordered } from "@/socket/board-events";
import {
  apiSuccess,
  apiUnauthorized,
  apiBadRequest,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";

const reorderColumnsSchema = z.object({
  columnIds: z.array(z.string().cuid()).min(1),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    console.log('[REORDER] === Reorder request started ===');
    const user = await requireApiUser(request);
    const { id: projectId } = await params;
    const body = await request.json();
    console.log('[REORDER] Request body:', body);
    const parsed = reorderColumnsSchema.parse(body);
    console.log('[REORDER] Parsed columnIds:', parsed.columnIds);

    // Check project access
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        OR: [
          { ownerId: user.id },
          { members: { some: { userId: user.id, role: "PROJECT_ADMIN" } } },
        ],
      },
      select: { id: true },
    });

    console.log('[REORDER] Project found:', !!project, 'User globalRole:', user.globalRole);

    if (!project && user.globalRole !== "ADMIN") {
      console.log('[REORDER] Access denied');
      return apiUnauthorized();
    }

    // Verify all columns belong to this project
    const columns = await prisma.projectColumn.findMany({
      where: {
        id: { in: parsed.columnIds },
        projectId,
      },
      select: { id: true, position: true },
    });

    console.log('[REORDER] Columns found:', columns.length, 'expected:', parsed.columnIds.length);

    if (columns.length !== parsed.columnIds.length) {
      console.log('[REORDER] Some columns not found');
      return apiBadRequest("Некоторые колонки не найдены");
    }

    // Update positions using a two-step approach to avoid unique constraint violations
    console.log('[REORDER] Step 1: Setting temporary positions...');

    // Step 1: Set all columns to a temporary unique position (offset by 10000)
    const tempOffset = 10000;
    await prisma.$transaction(
      parsed.columnIds.map((columnId, index) =>
        prisma.projectColumn.update({
          where: { id: columnId },
          data: { position: tempOffset + index },
        })
      )
    );

    console.log('[REORDER] Step 2: Setting final positions...');

    // Step 2: Set the final positions
    await prisma.$transaction(
      parsed.columnIds.map((columnId, index) =>
        prisma.projectColumn.update({
          where: { id: columnId },
          data: { position: index },
        })
      )
    );

    console.log('[REORDER] Positions updated successfully');

    // Fetch updated columns
    const updatedColumns = await prisma.projectColumn.findMany({
      where: { projectId },
      orderBy: { position: "asc" },
    });
    console.log('[REORDER] Updated columns:', updatedColumns.map(c => ({ id: c.id, position: c.position })));

    emitColumnsReordered(projectId, updatedColumns);

    console.log('[REORDER] === Reorder successful ===');
    return apiSuccess(updatedColumns);
  } catch (error) {
    console.log('[REORDER] === ERROR ===', error instanceof Error ? { message: error.message, stack: error.stack } : error);
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось изменить порядок колонок");
  }
}
