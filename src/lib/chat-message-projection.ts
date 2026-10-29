/** One safe projection for GET, send replay and realtime. Caps belong only to a reader response. */
export function projectChatMessage<T extends { contentText: string; attachments: unknown; mentions: unknown; reactions: unknown; deletedAt?: Date | string | null; readBy?: unknown; canEdit?: unknown; canDelete?: unknown }>(message: T): T {
  const result = { ...message };
  delete result.canEdit; delete result.canDelete;
  if (message.deletedAt) return { ...result, contentText: "", attachments: [], mentions: [], reactions: {}, readBy: {} } as T;
  return result;
}

/** Mirrors existing content rule: cancelled requests take no discussion changes. */
export function canChangeOwnMessage(message: { authorId: string; deletedAt?: unknown; version?: number }, actorId: string,
  request: { state: string; authorId: string; contractVersion: number; deletedAt: unknown } | null, legacyCanWrite = false): boolean {
  if (message.authorId !== actorId || message.deletedAt || !Number.isInteger(message.version) || message.version! < 0) return false;
  if (request === null) return legacyCanWrite;
  return request.contractVersion === 1 && request.deletedAt === null && request.state !== "CANCELLED"
    && (request.state !== "DRAFT" || request.authorId === actorId);
}
