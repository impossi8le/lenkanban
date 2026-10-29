/**
 * Product rules for the ordinary/internal discussion split.
 *
 * This module is intentionally pure: route handlers load persisted facts and
 * pass them here. Nothing in this file trusts a client-provided role or a
 * client-side visibility switch.
 */

export const COMMENT_VISIBILITIES = ["PUBLIC", "INTERNAL"] as const;
export type CommentVisibility = (typeof COMMENT_VISIBILITIES)[number];

export type InternalAccessFacts = Readonly<{
  globalRole: "USER" | "ADMIN";
  /** Active member of the board's responsible group. */
  activeGroupMember: boolean;
  /** Configured leader of the board's active department. */
  activeDepartmentLeader: boolean;
  /** Explicit `request.read` + `request.internal.read` grant in scope. */
  scopedInternalGrant: boolean;
}>;

/**
 * Internal discussion is limited to the responsible group, its configured
 * leadership, global administrators and scoped department/board administrators.
 * Being the author or a watcher is deliberately not enough.
 */
export function canReadInternalDiscussion(facts: InternalAccessFacts): boolean {
  if (facts.globalRole === "ADMIN") return true;
  return facts.activeGroupMember || facts.activeDepartmentLeader || facts.scopedInternalGrant;
}

export type CommentRecipientFacts = Readonly<{
  actorId: string;
  visibility: CommentVisibility;
  authorId: string | null;
  executorId: string | null;
  watcherIds: readonly string[];
  /** Legacy TaskAssignee rows; the request executor replaces them when a marker exists. */
  assigneeIds?: readonly string[];
  /** Configured leadership only; no hierarchy walk and no whole-group broadcast. */
  managementIds?: readonly string[];
  /** Required for INTERNAL comments: recipients outside this set are dropped. */
  internalReaderIds?: ReadonlySet<string>;
}>;

/**
 * Ordinary comment recipients: author, executor, watchers and configured
 * leadership. The responsible group is intentionally not expanded here - it is
 * notified when a request enters/returns to the queue, not on every comment.
 *
 * A Set guarantees that overlapping roles never multiply delivery. The actor
 * is removed. Internal comments are additionally filtered to readers who may
 * see the internal part.
 */
export function resolveCommentRecipients(facts: CommentRecipientFacts): string[] {
  const recipients = new Set<string>();
  for (const userId of [
    facts.authorId,
    facts.executorId,
    ...facts.watcherIds,
    ...(facts.assigneeIds ?? []),
    ...(facts.managementIds ?? []),
  ]) {
    if (userId) recipients.add(userId);
  }
  recipients.delete(facts.actorId);

  if (facts.visibility === "INTERNAL") {
    const readers = facts.internalReaderIds ?? new Set<string>();
    for (const userId of [...recipients]) {
      if (!readers.has(userId)) recipients.delete(userId);
    }
  }

  return [...recipients].sort();
}

/**
 * Queue notification recipients (submission / return to queue): the whole
 * responsible group and configured leadership, deduplicated, actor excluded.
 */
export function resolveQueueRecipients(facts: Readonly<{
  actorId: string;
  groupMemberIds: readonly string[];
  managementIds?: readonly string[];
}>): string[] {
  const recipients = new Set<string>([...facts.groupMemberIds, ...(facts.managementIds ?? [])]);
  recipients.delete(facts.actorId);
  return [...recipients].sort();
}

/** Strict server-side interpretation of the comment type. */
export function normalizeCommentVisibility(
  value: unknown,
  legacyIsInternal?: unknown,
): CommentVisibility | null {
  if (legacyIsInternal !== undefined && typeof legacyIsInternal !== "boolean") return null;
  const fromLegacy: CommentVisibility | undefined = legacyIsInternal === undefined
    ? undefined
    : legacyIsInternal ? "INTERNAL" : "PUBLIC";

  if (value === undefined) return fromLegacy ?? "PUBLIC";
  if (value !== "PUBLIC" && value !== "INTERNAL") return null;
  if (fromLegacy !== undefined && fromLegacy !== value) return null;
  return value;
}
