import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { requireApiUser } from "@/lib/require-api-user";
import {
  apiSuccess,
  apiUnauthorized,
  apiNotFound,
  apiBadRequest,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";

const createTagSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9A-F]{6}$/i, "Неверный hex-цвет"),
  projectId: z.string().cuid(),
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");

  if (!projectId) {
    return apiBadRequest("projectId is required");
  }

  try {
    const user = await requireApiUser(request);

    // Check project access
    if (user.globalRole !== "ADMIN") {
      const project = await prisma.project.findFirst({
        where: {
          id: projectId,
          OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
        },
        select: { id: true },
      });
      if (!project) {
        return apiNotFound();
      }
    }

    const tags = await prisma.tag.findMany({
      where: { projectId },
      orderBy: { name: "asc" },
    });

    return apiSuccess(tags);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось загрузить теги");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(request);
    const body = await request.json();
    const parsed = createTagSchema.parse(body);

    // Check project access
    if (user.globalRole !== "ADMIN") {
      const project = await prisma.project.findFirst({
        where: {
          id: parsed.projectId,
          OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
        },
        select: { id: true },
      });
      if (!project) {
        return apiNotFound();
      }
    }

    // Check if tag name already exists in project
    const existingTag = await prisma.tag.findFirst({
      where: {
        projectId: parsed.projectId,
        name: parsed.name,
      },
    });

    if (existingTag) {
      return apiBadRequest("Tag with this name already exists in project");
    }

    const tag = await prisma.tag.create({
      data: parsed,
    });

    return apiSuccess(tag, undefined, 201);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось создать тег");
  }
}
