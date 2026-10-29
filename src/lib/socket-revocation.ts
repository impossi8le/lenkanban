import type { QueryClient } from "@tanstack/react-query";

/**
 * Client reaction to server-side revocation. Kept outside components so the
 * board, task panel and notification socket share one handler implementation.
 */
export interface RevocationSocket {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off(event: string, handler: (...args: unknown[]) => void): unknown;
}

export interface RevocationActions {
  queryClient: Pick<QueryClient, "clear" | "removeQueries">;
  navigate: (path: string) => void;
}

export interface RevocationHandlers {
  authRevoked: (payload: unknown) => void;
  projectAccessRevoked: (payload: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createRevocationHandlers({ queryClient, navigate }: RevocationActions): RevocationHandlers {
  return {
    authRevoked(payload) {
      if (!isRecord(payload) || typeof payload.userId !== "string" || payload.userId.length === 0) return;
      queryClient.clear();
      navigate("/sign-in");
    },
    projectAccessRevoked(payload) {
      if (!isRecord(payload) || typeof payload.projectId !== "string" || payload.projectId.length === 0) return;
      const projectId = payload.projectId;
      queryClient.removeQueries({ predicate: query => query.queryKey.includes(projectId) });
      navigate("/projects");
    },
  };
}

type Channel = "auth" | "project";
type Handler = (payload: unknown) => void;
type Registry = {
  handlers: Record<Channel, Set<Handler>>;
  dispatch: Record<Channel, Handler>;
};

const EVENTS: Record<Channel, string> = {
  auth: "auth.revoked",
  project: "project:access-revoked",
};
const registries = new WeakMap<RevocationSocket, Registry>();

function registryFor(socket: RevocationSocket): Registry {
  const existing = registries.get(socket);
  if (existing) return existing;
  const handlers: Record<Channel, Set<Handler>> = { auth: new Set(), project: new Set() };
  const dispatch: Record<Channel, Handler> = {
    auth: payload => { for (const handler of [...handlers.auth]) handler(payload); },
    project: payload => { for (const handler of [...handlers.project]) handler(payload); },
  };
  const created: Registry = { handlers, dispatch };
  registries.set(socket, created);
  return created;
}

function subscribe(socket: RevocationSocket, channel: Channel, handler: Handler): () => void {
  const registry = registryFor(socket);
  if (registry.handlers[channel].size === 0) socket.on(EVENTS[channel], registry.dispatch[channel]);
  registry.handlers[channel].add(handler);
  return () => {
    registry.handlers[channel].delete(handler);
    if (registry.handlers[channel].size === 0) socket.off(EVENTS[channel], registry.dispatch[channel]);
  };
}

/** One listener per socket regardless of how many hooks subscribe. */
export function subscribeAuthRevoked(socket: RevocationSocket, handler: Handler): () => void {
  return subscribe(socket, "auth", handler);
}

export function subscribeProjectAccessRevoked(socket: RevocationSocket, handler: Handler): () => void {
  return subscribe(socket, "project", handler);
}
