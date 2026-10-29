import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  createRevocationHandlers,
  subscribeAuthRevoked,
  subscribeProjectAccessRevoked,
  type RevocationSocket,
} from "./socket-revocation";

function seededClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(["tasks", "p1"], [{ id: "t1" }]);
  client.setQueryData(["columns", "p1"], [{ id: "c1" }]);
  client.setQueryData(["tasks", "p2"], [{ id: "t2" }]);
  client.setQueryData(["notifications", "actor-a"], [{ id: "n1" }]);
  return client;
}

describe("client revocation handlers", () => {
  it("clears every cached query and leaves for sign-in on auth.revoked", () => {
    const queryClient = seededClient();
    const navigate = vi.fn();
    const handlers = createRevocationHandlers({ queryClient, navigate });

    handlers.authRevoked({ userId: "actor-a", reason: "role-demoted" });

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/sign-in");
  });

  it("drops only the revoked project's cache and leaves its board", () => {
    const queryClient = seededClient();
    const navigate = vi.fn();
    const handlers = createRevocationHandlers({ queryClient, navigate });

    handlers.projectAccessRevoked({ projectId: "p1" });

    const keys = queryClient.getQueryCache().getAll().map(query => query.queryKey);
    expect(keys).toEqual([["tasks", "p2"], ["notifications", "actor-a"]]);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/projects");
  });

  it("ignores malformed payloads instead of clearing unrelated state", () => {
    const queryClient = seededClient();
    const navigate = vi.fn();
    const handlers = createRevocationHandlers({ queryClient, navigate });

    handlers.authRevoked({});
    handlers.authRevoked(null);
    handlers.projectAccessRevoked({ projectId: "" });
    handlers.projectAccessRevoked("project:p1");

    expect(queryClient.getQueryCache().getAll()).toHaveLength(4);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("installs one socket listener and releases it with the last subscriber", () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const socket: RevocationSocket = {
      on(event, handler) {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
        return socket;
      },
      off(event, handler) {
        listeners.get(event)?.delete(handler);
        return socket;
      },
    };
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeAuthRevoked(socket, first);
    const unsubscribeSecond = subscribeAuthRevoked(socket, second);
    expect(listeners.get("auth.revoked")?.size).toBe(1);

    for (const listener of [...(listeners.get("auth.revoked") ?? [])]) listener({ userId: "a" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    expect(listeners.get("auth.revoked")?.size).toBe(1);
    unsubscribeSecond();
    expect(listeners.get("auth.revoked")?.size).toBe(0);

    const project = vi.fn();
    const unsubscribeProject = subscribeProjectAccessRevoked(socket, project);
    expect(listeners.get("project:access-revoked")?.size).toBe(1);
    unsubscribeProject();
    expect(listeners.get("project:access-revoked")?.size).toBe(0);
  });
});
