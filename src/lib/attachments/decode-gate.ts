/**
 * Per-process admission gate for expensive content decoding (images, ZIP
 * packages). Rate limiting bounds how often a client may ask; this bounds how
 * many decodes one process performs at once. The queue is bounded too, so a
 * burst cannot grow memory without limit.
 */
export const MAX_CONCURRENT_DECODES = 4;
export const MAX_QUEUED_DECODES = 32;

export class AttachmentBusyError extends Error {
  readonly code = "BUSY";
  constructor() {
    super("Attachment decoder is busy");
    this.name = "AttachmentBusyError";
  }
}

let active = 0;
const waiters: Array<{ resolve: () => void }> = [];

/**
 * Runs `work` while holding one decode slot. A finished holder transfers its
 * slot directly to the next waiter, so `active` never overshoots the limit.
 */
export async function withDecodeSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_DECODES) {
    if (waiters.length >= MAX_QUEUED_DECODES) throw new AttachmentBusyError();
    await new Promise<void>(resolve => { waiters.push({ resolve }); });
  } else {
    active += 1;
  }
  try {
    return await work();
  } finally {
    const next = waiters.shift();
    if (next) next.resolve();
    else active -= 1;
  }
}
