import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { isAutomationTrigger, parseAutomationActions } from "@/lib/automation-actions";
import { apiLogger } from "@/lib/logger";
import {
  apiSuccess,
  apiUnauthorized,
  apiBadRequest,
  apiForbidden,
  apiInvalidJson,
  apiInternalError
} from "@/lib/api-response";

export async function GET(request: Request) {
  try {
    const user = await requireApiUser(request);
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");

    if (!projectId) {
      return apiBadRequest("projectId is required");
    }

    // Check if user has access to this project
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        OR: [
          { ownerId: user.id },
          { members: { some: { userId: user.id } } },
        ],
      },
    });

    if (!project && user.globalRole !== "ADMIN") {
      return apiForbidden("Нет доступа к проекту");
    }

    const automationRules = await prisma.automationRule.findMany({
      where: { projectId },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return apiSuccess(automationRules);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    reportFailure("automation.rules.read.failed", error);
    return apiInternalError("Не удалось загрузить правила автоматизации");
  }
}

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  try {
    const user = await requireApiUser(request);
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      return apiBadRequest("Некорректное правило автоматизации");
    }
    const body: Record<string, unknown> = { ...json };

    const {
      projectId,
      name,
      description,
      trigger,
      conditions,
      actions: rawActions,
    } = body;

    if (typeof projectId !== "string" || projectId.length === 0
      || typeof name !== "string" || name.length === 0 || typeof trigger !== "string") {
      return apiBadRequest("Отсутствуют обязательные поля");
    }
    // Only events the shared mutation paths emit may be subscribed to.
    if (!isAutomationTrigger(trigger)) return apiBadRequest("Недопустимый триггер правила");
    const actions = parseAutomationActions(rawActions);
    if (!actions) return apiBadRequest("Допустимы только действия уведомления");

    // Check if user has access to this project
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        OR: [
          { ownerId: user.id },
          { members: { some: { userId: user.id } } },
        ],
      },
    });

    if (!project && user.globalRole !== "ADMIN") {
      return apiForbidden("Нет доступа к проекту");
    }

    const automationRule = await prisma.automationRule.create({
      data: {
        projectId,
        name,
        description: typeof description === "string" && description.length > 0 ? description : null,
        trigger,
        conditions: conditions || [],
        actions: actions.map(action => ({ type: action.type, params: { ...action.params } })),
        createdById: user.id,
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

    return apiSuccess(automationRule, undefined, 201);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    reportFailure("automation.rules.create.failed", error);
    return apiInternalError("Не удалось создать правило автоматизации");
  }
}

function reportFailure(event: "automation.rules.read.failed" | "automation.rules.create.failed", error: unknown) {
  try { apiLogger.error({ event, route: "/api/automation-rules", err: error }); }
  catch { /* No raw fallback. */ }
}
