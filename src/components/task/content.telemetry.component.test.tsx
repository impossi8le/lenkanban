import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientTelemetryEvent } from "@/lib/telemetry/contract";

const bridge = vi.hoisted(() => ({ current: null as unknown, connected: false,
  handlers: new Map<string, Set<(...args: unknown[]) => void>>(),
  socket: { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock("@/lib/telemetry/client", async () => ({
  ...await vi.importActual("@/lib/telemetry/client"),
  getBrowserTelemetryClient: () => bridge.current,
}));
vi.mock("@/hooks/useTaskChat", () => ({
  useTaskChat: () => ({ socket: bridge.connected ? bridge.socket : null,
    isConnected: bridge.connected, isJoined: bridge.connected, lastError: null }),
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "actor", name: "Actor" } } }),
}));
import { TelemetryClient } from "@/lib/telemetry/client";
import { TaskChatPanel } from "./TaskChatPanel";
import { TaskAttachments } from "./TaskAttachments";

const TEXT = "synthetic-private-comment-token";
const NAME = "synthetic-private-file.pdf";
const URL = "/api/tasks/task/files/private-file-url";
const uploaded = { url: URL, name: NAME, size: 12, mime: "application/pdf" };
const expiry = "2026-10-21T12:00:00.000Z";
let queue: TelemetryClient;
let query: QueryClient;
let events: ClientTelemetryEvent[];
const business = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(yes => { resolve = yes; });
  return { promise, resolve };
}
function ok(data: unknown) { return Response.json({ success: true, data }); }
beforeEach(async () => {
  bridge.connected = false;
  bridge.handlers.clear();
  bridge.socket.emit.mockReset();
  bridge.socket.on.mockImplementation((name: string, handler: (...args: unknown[]) => void) => {
    if (!bridge.handlers.has(name)) bridge.handlers.set(name, new Set());
    bridge.handlers.get(name)!.add(handler);
  });
  bridge.socket.off.mockImplementation((name: string, handler: (...args: unknown[]) => void) => bridge.handlers.get(name)?.delete(handler));
  events = [];
  business.mockReset();
  business.mockImplementation(async () => ok({ items: [], nextCursor: null, canReadInternal: true }));
  const fetchMock: typeof fetch = async (input, init) => {
    if (String(input) !== "/api/telemetry") return business(String(input), init);
    const body = JSON.parse(String(init?.body));
    if (body.kind === "session.start") return ok({ sessionId: body.sessionId,
      sessionToken: `v1.${Date.parse(expiry)}.${"a".repeat(64)}`, expiresAt: expiry });
    events.push(...body.events);
    return ok({ accepted: body.events.map((event: ClientTelemetryEvent) => event.eventId) });
  };
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  let seq = 0;
  queue = new TelemetryClient({ fetch: fetchMock, wallClock: () => new Date("2026-10-20T12:00:00.000Z"),
    uuid: () => `${(++seq).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111` });
  bridge.current = queue;
  await queue.setIdentity("actor");
  query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => {
  cleanup(); query.clear(); queue.dispose(); bridge.current = null;
  vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});
async function flush() { await act(async () => queue.flush()); }
function results(action: string) { return events.filter(event => event.event === "client.request.result" && event.action === action); }
function assertPrivate() {
  for (const secret of [TEXT, NAME, URL]) expect(JSON.stringify(events)).not.toContain(secret);
}
it.each([true, false])("records attachment.upload only after direct upload success=%s, without file metadata", async success => {
  const response = deferred();
  business.mockImplementation(async () => response.promise);
  const updated = vi.fn();
  const view = render(<TaskAttachments taskId="task" attachments={[]} canUpload onUpdate={updated} />);
  await userEvent.upload(view.container.querySelector('input[type="file"]')!, new File(["%PDF-1.7"], NAME, { type: "application/pdf" }));
  await waitFor(() => expect(business).toHaveBeenCalledTimes(1));
  await flush();
  expect(results("attachment.upload")).toEqual([]);
  expect(updated).not.toHaveBeenCalled();
  await act(async () => response.resolve(success ? ok({ uploaded: [uploaded], count: 1 })
    : Response.json({ error: { message: NAME } }, { status: 500 })));
  if (success) await waitFor(() => expect(updated).toHaveBeenCalledWith([uploaded]));
  else await screen.findByText(NAME);
  await flush();
  expect(results("attachment.upload")).toEqual([expect.objectContaining({ outcome: success ? "success" : "failure" })]);
  expect(events.some(event => event.event === "ui.action" && event.action === "attachment.upload")).toBe(true);
  assertPrivate();
});

it.each([true, false])("waits for persisted finalize success=%s before reporting a chat attachment result", async success => {
  const response = deferred();
  business.mockImplementation(async (url, init) => {
    if (url === "/api/uploads/presign") return init?.method === "PUT" ? ok({ uploaded: true })
      : ok({ uploadUrl: "/api/uploads/presign", method: "PUT", headers: {}, token: "private-upload-token" });
    if (url === "/api/uploads/finalize") return response.promise;
    return ok({ items: [], nextCursor: null, canReadInternal: true });
  });
  render(<QueryClientProvider client={query}><TaskChatPanel taskId="task" /></QueryClientProvider>);
  await screen.findByText("Пока нет сообщений");
  await userEvent.upload(screen.getByLabelText("Прикрепить файлы к сообщению"), new File(["%PDF-1.7"], NAME, { type: "application/pdf" }));
  await waitFor(() => expect(business.mock.calls.some(([url]) => url === "/api/uploads/finalize")).toBe(true));
  await flush();
  expect(results("attachment.upload")).toEqual([]);
  await act(async () => response.resolve(success ? ok({ attachment: uploaded, created: true })
    : Response.json({ error: { message: NAME } }, { status: 500 })));
  await screen.findByText(success ? "готово" : "ошибка");
  await flush();
  expect(results("attachment.upload")).toEqual([expect.objectContaining({ outcome: success ? "success" : "failure" })]);
  assertPrivate();
  expect(JSON.stringify(events)).not.toContain("private-upload-token");
});

it.each([true, false])("reports public comment success=%s from canonical persistence, never optimistic state or ACK alone", async success => {
  bridge.connected = true;
  render(<QueryClientProvider client={query}><TaskChatPanel taskId="task" /></QueryClientProvider>);
  await screen.findByText("Пока нет сообщений");
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText("Сообщение... (Enter — отправить)"), TEXT);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(bridge.socket.emit.mock.calls.some(([name]) => name === "message:send")).toBe(true));
  const [, payload, ack] = bridge.socket.emit.mock.calls.find(([name]) => name === "message:send")!;
  await flush();
  expect(results("comment.create")).toEqual([]);
  await act(async () => ack({ ok: true }));
  await flush();
  expect(results("comment.create")).toEqual([]);
  await act(async () => {
    if (success) {
      for (const handler of [...bridge.handlers.get("message:new")!]) handler({ ...payload, id: "stored",
        authorId: "actor", author: { id: "actor", email: "actor@example.invalid", name: "Actor", avatarUrl: null },
        mentions: [], reactions: {}, createdAt: "2026-10-20T12:00:00Z" });
    } else ack({ ok: false, error: TEXT });
  });
  await flush();
  expect(results("comment.create")).toEqual([expect.objectContaining({ outcome: success ? "success" : "failure" })]);
  assertPrivate();
});
