import { NotFoundError } from "./errors";
import { toTaskDetailDTO } from "./task-detail-dto";
import { readVisibleTaskAttachments, type AttachmentReadDatabase } from "./attachments/task-port";
import { readRequestQueueArrivalMap, type RequestQueueReadDatabase } from "./request-queue-unseen";

/** Shared actor-specific SSR/HTTP detail projection; never records a view on GET. */
export async function toTaskDetailForReader(
  database: AttachmentReadDatabase & RequestQueueReadDatabase,
  actor: { id: string; globalRole: "USER" | "ADMIN" },
  stored: Parameters<typeof toTaskDetailDTO>[0],
) {
  const arrivals = await readRequestQueueArrivalMap(database, actor.id, [stored.id]);
  if (!arrivals.has(stored.id)) throw new NotFoundError();
  const attachments = await readVisibleTaskAttachments(database, actor, stored.projectId, stored.attachments);
  return { ...toTaskDetailDTO(stored, attachments), queueArrival: arrivals.get(stored.id) ?? null };
}
