import { canActorReadInternal, loadProjectDiscussionFacts, loadInternalMessageIds } from "@/app/api/tasks/[id]/messages/discussion-access";
import { readTaskAttachmentAccess } from "@/lib/attachments/task-port";
import { visibleAttachmentProvenanceCount } from "@/lib/task-change-attachment-provenance";
import { prisma } from "@/lib/prisma";
import { findAvailableRelatedEndpoint } from "@/lib/task-related-access";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { apiSuccess, apiUnauthorized, apiBadRequest, apiForbidden, apiInternalError } from "@/lib/api-response";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get("taskId");

  if (!taskId) {
    return apiBadRequest("taskId обязателен");
  }

  try {
    const user = await requireApiUser(request);

    // History is a read channel: it uses the same availability predicate as the
    // card and never reveals that a hidden/deleted/corrupt task exists.
    const task = await findAvailableRelatedEndpoint(prisma, user, taskId);

    if (!task && user.globalRole !== "ADMIN") {
      return apiForbidden("Доступ к этой задаче запрещен");
    }

    const activities = await prisma.activity.findMany({
      where: { taskId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50, // Limit to last 50 activities
    });

    // Relationship history is visible only while the other endpoint remains
    // readable. Filtering the whole row avoids leaking a hidden ID or count.
    const relatedIds = new Set<string>();
    for (const row of activities) if (row.action === "related_request_added" || row.action === "related_request_removed") {
      const value = row.action === "related_request_added" ? row.newValue : row.oldValue;
      if (value && typeof value === "object" && !Array.isArray(value) && typeof value.relatedTaskId === "string") relatedIds.add(value.relatedTaskId);
    }
    const visibleRelated = new Set<string>();
    for (const relatedId of relatedIds) {
      const endpoint = await findAvailableRelatedEndpoint(prisma, user, relatedId);
      if (endpoint) visibleRelated.add(endpoint.id);
    }
    const relatedVisibleActivities = activities.filter(row => {
      if (row.action !== "related_request_added" && row.action !== "related_request_removed") return true;
      const value = row.action === "related_request_added" ? row.newValue : row.oldValue;
      return value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.relatedTaskId === "string" && visibleRelated.has(value.relatedTaskId);
    });
    // New exact file provenance stays server-only. Filter the full event using
    // current file visibility, including duplicate/internal classification caps.
    const hasProvenance = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) && "files" in value;
    const fileHistory = relatedVisibleActivities.some(row => row.action === "attachment_added" && hasProvenance(row.newValue));
    const readableFiles = fileHistory && task ? await readTaskAttachmentAccess(prisma, taskId, user.id) : null;
    const visibleUrls = new Set(readableFiles?.status === "ok" ? readableFiles.attachments.map(file => file.url) : []);
    const visibleActivities = relatedVisibleActivities.flatMap(row => {
      if (row.action !== "attachment_added" || !hasProvenance(row.newValue)) return [row];
      const count = visibleAttachmentProvenanceCount(row.newValue, visibleUrls);
      return count > 0 ? [{ ...row, oldValue: null, newValue: { count } }] : [];
    });
    const messageHistory = visibleActivities.filter(row => row.action === "message_edited" || row.action === "message_deleted");
    if (!messageHistory.length) return apiSuccess(visibleActivities);
    if (!task) return apiSuccess(visibleActivities.filter(row => !messageHistory.includes(row)));
    const internal = await canActorReadInternal(prisma, user, await loadProjectDiscussionFacts(prisma, task.projectId));
    const internalIds = await loadInternalMessageIds(prisma, taskId);
    return apiSuccess(visibleActivities.filter(row => {
      if (row.action !== "message_edited" && row.action !== "message_deleted") return true;
      const before = row.oldValue, after = row.newValue;
      // A malformed classification never turns historical text into public data.
      if (!before || !after || typeof before !== "object" || typeof after !== "object" || Array.isArray(before) || Array.isArray(after)
        || typeof before.messageId !== "string" || before.messageId !== after.messageId
        || typeof before.isInternal !== "boolean" || before.isInternal !== after.isInternal) return false;
      return internal || (!before.isInternal && !internalIds?.has(before.messageId));
    }));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось загрузить активности");
  }
}
