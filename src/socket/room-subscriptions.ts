export interface RoomActor {
  userId: string;
  globalRole: "USER" | "ADMIN";
}

export interface RoomSubscriptionDependencies {
  expectedUserId: string;
  authenticate: () => Promise<RoomActor | null>;
  canReadProject: (actor: RoomActor, projectId: string) => Promise<boolean>;
  taskProject: (taskId: string) => Promise<string | null>;
  canReadTask?: (actor: RoomActor, taskId: string) => Promise<boolean>;
  join: (room: string) => void | Promise<void>;
  leave: (room: string) => void | Promise<void>;
}

type Result = { ok: true } | { ok: false; error: string };
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function readId(payload: unknown, key: string): string | null {
  try {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const value = (payload as Record<string, unknown>)[key];
    return validId(value) ? value : null;
  } catch { return null; }
}

/** Per-socket admission intents; this does not implement ongoing access revocation. */
export function createRoomSubscriptions(deps: RoomSubscriptionDependencies) {
  const intents = new Map<string, symbol>();
  const operations = new Map<string, Promise<void>>();
  let disconnected = false;
  const reply = (ack: unknown, result: Result) => {
    try { if (typeof ack === "function") ack(result); } catch { /* Transport callbacks are best effort. */ }
  };
  const enqueue = (room: string, operation: () => Promise<void>): Promise<void> => {
    const pending = (operations.get(room) ?? Promise.resolve()).then(operation, operation);
    operations.set(room, pending);
    void pending.then(() => { if (operations.get(room) === pending) operations.delete(room); }, () => { if (operations.get(room) === pending) operations.delete(room); });
    return pending;
  };
  const leaveRoom = (room: string): Promise<void> => {
    intents.delete(room);
    return enqueue(room, async () => { try { await deps.leave(room); } catch { /* A failed leave cannot reject an event handler. */ } });
  };
  const admit = async (kind: "project" | "task" | "user", id: string, ack: unknown): Promise<void> => {
    const room = `${kind}:${id}`;
    const intent = Symbol();
    intents.set(room, intent);
    const current = () => !disconnected && intents.get(room) === intent;
    const deny = async (error: string): Promise<void> => {
      await enqueue(room, async () => {
        if (!current()) { reply(ack, { ok: false, error: "SubscriptionCancelled" }); return; }
        try { await deps.leave(room); } catch { /* Best-effort cleanup after failed re-admission. */ }
        reply(ack, { ok: false, error });
      });
    };
    try {
      if (!current()) { reply(ack, { ok: false, error: "SubscriptionCancelled" }); return; }
      const actor = await deps.authenticate();
      if (!actor || actor.userId !== deps.expectedUserId) {
        await deny("Unauthorized");
        return;
      }
      let projectId: string | null = kind === "project" ? id : null;
      if (kind === "task") projectId = await deps.taskProject(id);
      const canRead = kind === "task" && deps.canReadTask
        ? await deps.canReadTask(actor, id)
        : kind === "user" || Boolean(projectId && await deps.canReadProject(actor, projectId));
      if (!canRead) {
        await deny("AccessDenied");
        return;
      }
      if (!current()) { reply(ack, { ok: false, error: "SubscriptionCancelled" }); return; }
      await enqueue(room, async () => {
        if (!current()) { reply(ack, { ok: false, error: "SubscriptionCancelled" }); return; }
        await deps.join(room);
        if (!current()) {
          // Serialized room operations prevent this cleanup removing a newer join.
          await deps.leave(room);
          reply(ack, { ok: false, error: "SubscriptionCancelled" });
          return;
        }
        reply(ack, { ok: true });
      });
    } catch {
      await deny("RoomJoinFailed");
    } finally {
      if (intents.get(room) === intent) intents.delete(room);
    }
  };
  return {
    joinProject(payload: unknown, ack?: unknown): Promise<void> {
      const id = readId(payload, "projectId");
      if (!id) { reply(ack, { ok: false, error: "InvalidRoomPayload" }); return Promise.resolve(); }
      return admit("project", id, ack);
    },
    joinTask(payload: unknown, ack?: unknown): Promise<void> {
      const id = readId(payload, "taskId");
      if (!id) { reply(ack, { ok: false, error: "InvalidRoomPayload" }); return Promise.resolve(); }
      return admit("task", id, ack);
    },
    joinNotifications(ack?: unknown): Promise<void> { return admit("user", deps.expectedUserId, ack); },
    leaveProject(payload: unknown): Promise<void> { const id = readId(payload, "projectId"); return id ? leaveRoom(`project:${id}`) : Promise.resolve(); },
    leaveTask(payload: unknown): Promise<void> { const id = readId(payload, "taskId"); return id ? leaveRoom(`task:${id}`) : Promise.resolve(); },
    leaveNotifications(): Promise<void> { return leaveRoom(`user:${deps.expectedUserId}`); },
    disconnect(): void { disconnected = true; intents.clear(); },
  };
}
