import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationBell } from "./notification-bell";

const controls = vi.hoisted(() => ({
  actor: "actor-a" as string | null, status: "authenticated", push: vi.fn(), socket: null as unknown,
}));
vi.mock("next-auth/react", () => ({ useSession: () => ({
  data: controls.actor ? { user: { id: controls.actor } } : null, status: controls.status,
}) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: controls.push }) }));
vi.mock("@/hooks/useNotificationSocket", () => ({ useNotificationSocket: () => ({ socket: controls.socket }) }));

type Listener = () => void;
class SocketBoundary {
  listeners = new Set<Listener>();
  on(event: string, listener: Listener) { if (event === "notification:new") this.listeners.add(listener); }
  off(event: string, listener: Listener) { if (event === "notification:new") this.listeners.delete(listener); }
  receive() { [...this.listeners].forEach(listener => listener()); }
}
const notices = {
  "actor-a": { id: "notice-a", title: "Private A title", message: "Private A body", actionUrl: "/projects/private-a/board?task=a" },
  "actor-b": { id: "notice-b", title: "Private B title", message: "Private B body", actionUrl: "/projects/private-b/board?task=b" },
};
const clients: QueryClient[] = [];
const requests: { actor: string | null; url: string; method: string; signal?: AbortSignal | null }[] = [];
let deferListA: boolean;
let finishListA: (() => void) | undefined;
let deferPatch: boolean;
let finishPatch: (() => void) | undefined;
let socketA: SocketBoundary;
let socketB: SocketBoundary;

function response(data: unknown) { return Response.json({ success: true, data }); }
beforeEach(() => {
  controls.actor = "actor-a"; controls.status = "authenticated"; controls.push.mockReset();
  socketA = new SocketBoundary(); socketB = new SocketBoundary(); controls.socket = socketA;
  requests.length = 0; deferListA = false; finishListA = undefined; deferPatch = false; finishPatch = undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const actor = controls.actor;
    const method = options?.method ?? "GET";
    requests.push({ actor, url, method, signal: options?.signal });
    if (method === "PATCH") {
      if (deferPatch) await new Promise<void>(resolve => { finishPatch = resolve; });
      return response(null);
    }
    if (url.endsWith("unread-count")) return response({ actorId: actor, count: actor === "actor-a" ? 3 : 7, byProject: {}, byTask: {}, unscopedCount: actor === "actor-a" ? 3 : 7 });
    if (actor === "actor-a" && deferListA) await new Promise<void>(resolve => { finishListA = resolve; });
    const notice = notices[actor as keyof typeof notices];
    return response(notice ? [{ ...notice, type: "task_assigned", read: false, readAt: null, metadata: null, createdAt: "2026-10-21T10:00:00.000Z" }] : []);
  }));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const ui = () => <QueryClientProvider client={client}><NotificationBell /></QueryClientProvider>;
  return { ...render(ui()), client, ui };
}
async function openBell() {
  fireEvent.click(screen.getByRole("button", { name: "Уведомления" }));
  return screen.findByRole("dialog", { name: "Уведомления" });
}

it("isolates cached badge, content and action URL on actor switch and immediately hides them on logout", async () => {
  const view = mount();
  expect(await screen.findByText("3")).toBeVisible();
  await openBell();
  const oldButton = await screen.findByRole("button", { name: /Private A title/ });
  expect(oldButton).toHaveTextContent("Private A body");
  const oldSocketCallback = [...socketA.listeners][0];
  const invalidate = vi.spyOn(view.client, "invalidateQueries");
  controls.actor = "actor-b"; controls.socket = socketB; view.rerender(view.ui());
  expect(screen.queryByText("3")).not.toBeInTheDocument();
  expect(screen.queryByText("Private A title")).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(oldButton);
  expect(controls.push).not.toHaveBeenCalled();
  expect(requests.filter(request => request.method === "PATCH")).toEqual([]);
  act(() => oldSocketCallback());
  expect(invalidate).not.toHaveBeenCalled();
  expect(await screen.findByText("7")).toBeVisible();
  await openBell();
  expect(await screen.findByText("Private B title")).toBeVisible();
  act(() => socketB.receive());
  expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ["notifications", "actor-b"] });
  controls.actor = null; controls.status = "unauthenticated"; controls.socket = null; view.rerender(view.ui());
  expect(screen.queryByText("7")).not.toBeInTheDocument();
  expect(screen.queryByText("Private B body")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Уведомления" })).toBeDisabled();
  const requestCount = requests.length;
  fireEvent.click(screen.getByRole("button", { name: "Уведомления" }));
  await act(async () => {});
  expect(requests).toHaveLength(requestCount);
  expect(view.client.getQueryData(["notifications", "actor-a", "list"])).toBeUndefined();
  expect(view.client.getQueryData(["notifications", "actor-b", "list"])).toBeUndefined();
});

it("discards an old actor's deferred list result even when the transport ignores cancellation", async () => {
  deferListA = true;
  const view = mount();
  await screen.findByText("3"); await openBell();
  await waitFor(() => expect(finishListA).toBeTypeOf("function"));
  const oldListRequest = requests.find(request => request.actor === "actor-a" && request.url.includes("?limit="))!;
  controls.actor = "actor-b"; controls.socket = socketB; view.rerender(view.ui());
  expect(oldListRequest.signal?.aborted).toBe(true);
  await screen.findByText("7"); await openBell();
  expect(await screen.findByText("Private B title")).toBeVisible();
  await act(async () => finishListA?.());
  expect(screen.queryByText("Private A title")).not.toBeInTheDocument();
  expect(screen.getByText("Private B title")).toBeVisible();
  expect(view.client.getQueryData(["notifications", "actor-a", "list"])).toBeUndefined();
});

it.each(["single", "all"])("ignores a late %s PATCH success after an actor A-B-A cycle", async kind => {
  deferPatch = true;
  const view = mount(); await screen.findByText("3"); await openBell();
  if (kind === "single") fireEvent.click(await screen.findByRole("button", { name: /Private A title/ }));
  else fireEvent.click(screen.getByRole("button", { name: "Прочитать все" }));
  await waitFor(() => expect(finishPatch).toBeTypeOf("function"));
  expect(requests.filter(request => request.method === "PATCH").map(request => request.url))
    .toEqual([kind === "single" ? "/api/notifications/notice-a" : "/api/notifications/mark-all-read"]);
  controls.actor = "actor-b"; controls.socket = socketB; view.rerender(view.ui());
  await screen.findByText("7"); await openBell(); await screen.findByText("Private B title");
  controls.actor = "actor-a"; controls.socket = socketA; view.rerender(view.ui());
  await screen.findByText("3"); await openBell(); await screen.findByText("Private A title");
  const invalidate = vi.spyOn(view.client, "invalidateQueries");
  const requestCount = requests.length;
  const navigationCount = controls.push.mock.calls.length;
  await act(async () => finishPatch?.());
  expect(invalidate).not.toHaveBeenCalled();
  expect(requests).toHaveLength(requestCount);
  expect(controls.push).toHaveBeenCalledTimes(navigationCount);
  expect(screen.getByText("Private A title")).toBeVisible();
});

it.each(["loading", "unauthenticated"])("makes no notification request while session status is %s", async status => {
  controls.status = status;
  const view = mount();
  expect(screen.getByRole("button", { name: "Уведомления" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Уведомления" }));
  act(() => socketA.receive());
  await act(async () => {});
  expect(requests).toEqual([]);
  expect(view.client.getQueryData(["notifications", "actor-a", "unread-count"])).toBeUndefined();
});
