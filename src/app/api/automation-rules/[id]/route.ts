import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { isAutomationTrigger, parseAutomationActions } from "@/lib/automation-actions";
import { apiLogger } from "@/lib/logger";
import {
  apiSuccess,
  apiBadRequest,
  apiUnauthorized,
  apiNotFound,
  apiForbidden,
  apiInternalError
} from "@/lib/api-response";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await params;

    const automationRule = await prisma.automationRule.findUnique({
      where: { id },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        project: {
          select: {
            id: true,
            name: true,
            ownerId: true,
            members: {
              where: { userId: user.id },
              select: { userId: true },
            },
          },
        },
      },
    });

    if (!automationRule) {
      return apiNotFound("Правило автоматизации не найдено");
    }

    // Check access
    const hasAccess =
      user.globalRole === "ADMIN" ||
      automationRule.project.ownerId === user.id ||
      automationRule.project.members.length > 0;

    if (!hasAccess) {
      return apiForbidden("Нет доступа к правилу автоматизации");
    }

    return apiSuccess(automationRule);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    reportFailure("automation.rule.read.failed", error);
    return apiInternalError("Не удалось загрузить правило автоматизации");
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return apiBadRequest("Некорректное правило автоматизации");
    }

    const automationRule = await prisma.automationRule.findUnique({
      where: { id },
      include: {
        project: {
          select: {
            ownerId: true,
            members: {
              where: { userId: user.id },
              select: { userId: true },
            },
          },
        },
      },
    });

    if (!automationRule) {
      return apiNotFound("Правило автоматизации не найдено");
    }

    // Check access
    const hasAccess =
      user.globalRole === "ADMIN" ||
      automationRule.project.ownerId === user.id ||
      automationRule.project.members.length > 0;

    if (!hasAccess) {
      return apiForbidden("Нет доступа к правилу автоматизации");
    }

    // A changed trigger must stay inside the closed event catalog. Leaving it
    // untouched (rename, deactivation) keeps any stored legacy trigger.
    if (Object.hasOwn(body, "trigger") && !isAutomationTrigger(body.trigger)) {
      return apiBadRequest("Недопустимый триггер правила");
    }
    const hasActions = Object.hasOwn(body, "actions");
    const requiresActions = hasActions || (body.active !== false && (body.active === true
      || Object.hasOwn(body, "trigger") || Object.hasOwn(body, "conditions")));
    const actions = requiresActions ? parseAutomationActions(hasActions ? body.actions : automationRule.actions) : null;
    if (requiresActions && !actions) return apiBadRequest("Допустимы только действия уведомления");
    const updated = await prisma.automationRule.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description,
        trigger: body.trigger,
        conditions: body.conditions,
        actions: hasActions && actions ? actions.map(action => ({ type: action.type, params: { ...action.params } })) : undefined,
        active: body.active,
      },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return apiSuccess(updated);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    reportFailure("automation.rule.update.failed", error);
    return apiInternalError("Не удалось обновить правило автоматизации");
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await params;

    const automationRule = await prisma.automationRule.findUnique({
      where: { id },
      include: {
        project: {
          select: {
            ownerId: true,
            members: {
              where: { userId: user.id },
              select: { userId: true },
            },
          },
        },
      },
    });

    if (!automationRule) {
      return apiNotFound("Правило автоматизации не найдено");
    }

    // Check access
    const hasAccess =
      user.globalRole === "ADMIN" ||
      automationRule.project.ownerId === user.id ||
      automationRule.project.members.length > 0;

    if (!hasAccess) {
      return apiForbidden("Нет доступа к правилу автоматизации");
    }

    await prisma.automationRule.delete({
      where: { id },
    });

    return apiSuccess({ success: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    reportFailure("automation.rule.delete.failed", error);
    return apiInternalError("Не удалось удалить правило автоматизации");
  }
}

function reportFailure(event: "automation.rule.read.failed" | "automation.rule.update.failed" | "automation.rule.delete.failed", error: unknown) {
  try { apiLogger.error({ event, route: "/api/automation-rules/:id", err: error }); }
  catch { /* No raw fallback. */ }
}
