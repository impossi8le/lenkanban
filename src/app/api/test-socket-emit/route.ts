import { NextResponse } from "next/server";
import { emitTaskUpdated } from "@/socket/board-events";
import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { isGlobalAdmin } from "@/lib/require-user";
import { apiLogger } from "@/lib/logger";
import { withApiLogging } from "@/middleware/api-logger";
import type { RequestLogContext } from "@/lib/request-context";
import { hasConfiguredServiceSecret } from "@/lib/service-auth";

// Test endpoint to manually trigger Socket.IO event
export function GET(request: Request) {
  return withApiLogging(request, emitDiagnostic, { route: "/api/test-socket-emit" });
}

async function emitDiagnostic(request: Request, context: RequestLogContext) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const actor = await requireApiUser(request);
    context.actorId = actor.id;
    if (!isGlobalAdmin(actor)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    apiLogger.error({ ...context, event: "diagnostic.auth.failed", err: error });
    return NextResponse.json({ error: "Diagnostic unavailable" }, { status: 500 });
  }
  if (!hasConfiguredServiceSecret(process.env.INTERNAL_EMIT_SECRET)) {
    return NextResponse.json({ error: "Bridge is not configured" }, { status: 503 });
  }
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get("taskId");

  if (!taskId) {
    return NextResponse.json({ error: "taskId required" }, { status: 400 });
  }

  try {
    // Fetch task with all relations
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        assignees: {
          include: {
            user: {
              select: { id: true, email: true, name: true, avatarUrl: true },
            },
          },
        },
        tags: {
          include: {
            tag: true,
          },
        },
        checklistItems: {
          orderBy: { position: 'asc' },
        },
        project: {
          select: { id: true },
        },
      },
    });

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // Manually emit Socket.IO event
    emitTaskUpdated(task.project.id, task);

    return NextResponse.json({
      success: true,
      message: "Socket.IO emit requested; delivery is best effort",
      projectId: task.project.id,
      taskId: task.id,
    });
  } catch (error) {
    apiLogger.error({ ...context, event: "diagnostic.emit.failed", err: error });
    return NextResponse.json(
      { error: "Failed to request event" },
      { status: 500 }
    );
  }
}
