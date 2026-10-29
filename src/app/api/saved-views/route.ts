import { NextRequest } from "next/server";
import { requireDbUser } from "@/lib/require-user";
import { requireProjectRead } from "@/lib/project-access";
import { UnauthorizedError, NotFoundError } from "@/lib/errors";
import { apiLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import {
  apiSuccess,
  apiUnauthorized,
  apiBadRequest,
  apiNotFound,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";

const createSavedViewSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  projectId: z.string(),
  viewType: z.enum(["board", "table", "calendar"]).default("board"),
  filters: z.object({
    search: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    priority: z.string().nullable().optional(),
    assignee: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
  }).default({}),
  sortBy: z.string().default("position"),
  isDefault: z.boolean().default(false),
});

// GET /api/saved-views?projectId=xxx - List saved views for a project
export async function GET(req: NextRequest) {
  try {
    const user = await requireDbUser(req);

    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");

    if (!projectId) {
      return apiBadRequest("projectId is required");
    }

    await requireProjectRead(user, projectId);

    // Get saved views for this project and user
    const savedViews = await prisma.savedView.findMany({
      where: {
        projectId,
        createdById: user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return apiSuccess(savedViews);
  } catch (error) {
    if (error instanceof UnauthorizedError) return apiUnauthorized();
    if (error instanceof NotFoundError) return apiNotFound();
    apiLogger.error({ event: "api.request.failed", route: "/api/saved-views", method: "GET", statusCode: 500 }, "Saved view request failed");
    return apiInternalError("Не удалось загрузить сохраненные представления");
  }
}

// POST /api/saved-views - Create a new saved view
export async function POST(req: NextRequest) {
  try {
    const user = await requireDbUser(req);

    const body = await req.json();
    const data = createSavedViewSchema.parse(body);

    // Personal view preferences do not mutate requests. Match the item routes:
    // current project read access plus creator-only persistence.
    await requireProjectRead(user, data.projectId);

    // If this is set as default, unset other defaults for this user/project
    if (data.isDefault) {
      await prisma.savedView.updateMany({
        where: {
          projectId: data.projectId,
          createdById: user.id,
          isDefault: true,
        },
        data: {
          isDefault: false,
        },
      });
    }

    // Create the saved view
    const savedView = await prisma.savedView.create({
      data: {
        name: data.name,
        description: data.description,
        projectId: data.projectId,
        viewType: data.viewType,
        filters: data.filters,
        sortBy: data.sortBy,
        isDefault: data.isDefault,
        createdById: user.id,
      },
    });

    return apiSuccess(savedView, undefined, 201);
  } catch (error) {
    if (error instanceof UnauthorizedError) return apiUnauthorized();
    if (error instanceof NotFoundError) return apiNotFound();
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }

    apiLogger.error({ event: "api.request.failed", route: "/api/saved-views", method: "POST", statusCode: 500 }, "Saved view request failed");
    return apiInternalError("Не удалось создать сохраненное представление");
  }
}
