import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessageDTO } from "@/lib/chat-types";

const transport = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const listeners = new Map<string, Set<Listener>>();
  const joins: Listener[] = [];
  const sends: { payload: { clientId: string; taskId: string; contentText: string }; ack: Listener }[] = [];
  let throwOnSend = false;
  const socket = {
    connected: false,
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    off(event: string, listener: Listener) { listeners.get(event)?.delete(listener); },
    emit(event: string, _payload: unknown, ack?: Listener) {
      if (event === "task:join" && ack) joins.push(ack);
      if (event === "message:send" && ack) {
        if (throwOnSend) throw new Error("Synchronous transport failure");
        sends.push({ payload: _payload as typeof sends[number]["payload"], ack });
      }
    },
  };
  return { socket, listeners, joins, sends, failSends(value: boolean) { throwOnSend = value; }, receive(event: string, payload?: unknown) {
    if (event === "connect") socket.connected = true;
    if (event === "disconnect") socket.connected = false;
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
  } };
});
vi.mock("@/lib/socket-client", () => ({ getSocketInstance: () => transport.socket }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "user", name: "User", email: "user@example.com" } } }) }));
import { TaskChatPanel } from "./TaskChatPanel";

type Page = { items: (ChatMessageDTO & { __delivery?: "pending" | "failed" })[]; nextCursor: string | null };
const message = (id: string, contentText: string, taskId = "task"): ChatMessageDTO => ({
  id, clientId: null, taskId, contentText, authorId: "user", author: { id: "user", name: "User", email: "user@example.com", avatarUrl: null },
  attachments: [], mentions: [], reactions: {}, createdAt: "2026-09-14T00:00:00Z",
});
let page: Page;
let readRequests: { url: string; body: unknown }[];
let getCount: number;
let response: ((url: string) => Promise<Response>) | undefined;
let client: QueryClient;
let signals: (AbortSignal | null | undefined)[];
let readResponse: (() => Promise<Response>) | undefined;
beforeEach(() => {
  page = { items: [message("old", "Existing message")], nextCursor: null };
  readRequests = []; getCount = 0; response = undefined;
  signals = [];
  readResponse = undefined;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: () => {} });
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      readRequests.push({ url, body: JSON.parse(String(options.body)) });
      return readResponse ? readResponse() : Response.json({ success: true, data: {} });
    }
    getCount += 1;
    signals.push(options?.signal);
    return response ? response(url) : Response.json({ success: true, data: page });
  });
});

it.each([false, true])("batches 1001 loaded receipts sequentially and honors disconnect=%s between batches", async disconnect => {
  render(panel());
  await screen.findByText("Existing message");
  const history = Array.from({ length: 1001 }, (_, index) => ({
    ...message(`batch-${index}`, `Batch ${index}`),
    createdAt: new Date(Date.UTC(2026, 8, 14, 0, index)).toISOString(),
  }));
  response = async url => {
    const params = new URL(url, "http://localhost").searchParams;
    const cursor = params.get("cursor");
    const descending = [...history].reverse();
    const start = cursor ? descending.findIndex(item => item.id === cursor) + 1 : 0;
    const limit = Number(params.get("limit"));
    const items = descending.slice(start, start + limit).reverse();
    return Response.json({ success: true, data: { items, nextCursor: start + limit < history.length ? items[0].id : null } });
  };
  let finishRead!: (value: Response) => void;
  readResponse = () => new Promise(resolve => { finishRead = resolve; });
  await connect();
  await waitFor(() => expect(readRequests).toHaveLength(1));
  expect((readRequests[0].body as { messageIds: string[] }).messageIds).toEqual(history.slice(0, 1000).map(item => item.id));
  if (disconnect) await act(async () => transport.receive("disconnect"));
  readResponse = undefined;
  await act(async () => finishRead(Response.json({ success: true, data: {} })));
  if (disconnect) expect(readRequests).toHaveLength(1);
  else {
    await waitFor(() => expect(readRequests).toHaveLength(2));
    expect(readRequests[1].body).toEqual({ messageIds: ["batch-1000"] });
  }
}, 30000);
afterEach(() => {
  cleanup(); client.clear(); transport.listeners.clear(); transport.joins.length = 0;
  transport.sends.length = 0;
  transport.failSends(false);
  vi.useRealTimers();
  transport.socket.connected = false; vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

async function setupSend() {
  const view = await setup();
  await connect();
  vi.useFakeTimers();
  await act(async () => {
    const input = screen.getByPlaceholderText("Сообщение... (Enter — отправить)");
    fireEvent.change(input, { target: { value: "Keep this send" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await vi.advanceTimersByTimeAsync(0);
  });
  return view;
}
const sendingMessage = () => client.getQueryData<Page>(["task-messages", "task"])?.items.find(item => item.clientId === transport.sends[0]?.payload.clientId);

it("times out a dropped send ACK and retries the same client ID without accepting the old ACK", async () => {
  await setupSend();
  expect(transport.sends).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10001); });
  expect(sendingMessage()?.__delivery).toBe("failed");
  await act(async () => { fireEvent.click(screen.getByText("повторить")); await vi.advanceTimersByTimeAsync(0); });
  expect(transport.sends).toHaveLength(2);
  expect(transport.sends[1].payload.clientId).toBe(transport.sends[0].payload.clientId);
  await act(async () => { transport.sends[0].ack({ ok: false, error: "Late old failure" }); await vi.advanceTimersByTimeAsync(0); });
  expect(sendingMessage()?.__delivery).toBe("pending");
  await act(async () => {
    transport.receive("message:new", { ...message("sent", "Keep this send"), clientId: transport.sends[1].payload.clientId });
    transport.sends[1].ack({ ok: true });
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(sendingMessage()).toMatchObject({ id: "sent", __delivery: undefined });
  expect(transport.listeners.get("disconnect")?.size).toBe(1);
});

it("disconnect settles a send immediately and disables retry until the next successful join", async () => {
  await setupSend();
  await act(async () => { transport.receive("disconnect"); await vi.advanceTimersByTimeAsync(0); });
  expect(sendingMessage()?.__delivery).toBe("failed");
  expect(screen.getByText("повторить")).toBeDisabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(transport.sends).toHaveLength(1);
});

it("a canonical delivery remains confirmed after a late negative send ACK", async () => {
  await setupSend();
  await act(async () => {
    transport.receive("message:new", { ...message("sent", "Canonical delivered text"), clientId: transport.sends[0].payload.clientId, reactions: { "👍": ["user"] } });
    transport.sends[0].ack({ ok: false, error: "Late failure" });
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(sendingMessage()).toMatchObject({ id: "sent", contentText: "Canonical delivered text", reactions: { "👍": ["user"] }, __delivery: undefined });
  expect(screen.queryByText("повторить")).toBeNull();
});

it("canonical delivery unlocks sending immediately without an ACK, but foreign author events do not", async () => {
  await setupSend();
  const input = screen.getByPlaceholderText("Сообщение... (Enter — отправить)");
  await act(async () => {
    fireEvent.change(input, { target: { value: "Next draft" } });
    transport.receive("message:new", { ...message("foreign", "Foreign send", "other"), clientId: transport.sends[0].payload.clientId });
    transport.receive("message:new", { ...message("foreign-author", "Foreign author"), authorId: "other", clientId: transport.sends[0].payload.clientId });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(input.parentElement?.querySelector("button")).toBeDisabled();
  await act(async () => {
    transport.receive("message:new", { ...message("sent", "Keep this send"), clientId: transport.sends[0].payload.clientId });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(input.parentElement?.querySelector("button")).not.toBeDisabled();
  expect(input).toHaveValue("Next draft");
});

it("an ACK without canonical delivery remains bounded and retryable", async () => {
  await setupSend();
  await act(async () => { transport.sends[0].ack({ ok: true }); await vi.advanceTimersByTimeAsync(10001); });
  expect(sendingMessage()?.__delivery).toBe("failed");
  expect(screen.getByText("повторить")).not.toBeDisabled();
});

it("offline keyboard submission retains the draft without sending", async () => {
  await setup();
  const input = screen.getByPlaceholderText("Сообщение... (Enter — отправить)");
  await act(async () => {
    fireEvent.change(input, { target: { value: "Offline draft" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  });
  expect(input).toHaveValue("Offline draft");
  expect(transport.sends).toHaveLength(0);
});

it("disconnect between accepted submission and mutation startup retains a retryable message", async () => {
  await setup();
  await connect();
  const input = screen.getByPlaceholderText("Сообщение... (Enter — отправить)");
  await act(async () => {
    fireEvent.change(input, { target: { value: "Accepted draft" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    transport.receive("disconnect");
  });
  await waitFor(() => expect(client.getQueryData<Page>(["task-messages", "task"])?.items.find(item => item.contentText === "Accepted draft")?.__delivery).toBe("failed"));
  expect(transport.sends).toHaveLength(0);
});

it("a stale retry click cannot replace a message already confirmed by canonical delivery", async () => {
  await setupSend();
  await act(async () => { await vi.advanceTimersByTimeAsync(10001); });
  const retry = screen.getByText("повторить");
  await act(async () => {
    transport.receive("message:new", { ...message("sent", "Canonical before retry"), clientId: transport.sends[0].payload.clientId, reactions: { "👍": ["user"] } });
    fireEvent.click(retry);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(transport.sends).toHaveLength(1);
  expect(sendingMessage()).toMatchObject({ id: "sent", contentText: "Canonical before retry", __delivery: undefined, reactions: { "👍": ["user"] } });
});

it("a queued submission stays in its original task if the task switches before startup", async () => {
  const view = await setup();
  await connect();
  await act(async () => {
    const input = screen.getByPlaceholderText("Сообщение... (Enter — отправить)");
    fireEvent.change(input, { target: { value: "Original task payload" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    view.rerender(panel("other"));
  });
  await waitFor(() => expect(client.getQueryData<Page>(["task-messages", "task"])?.items.find(item => item.contentText === "Original task payload")?.__delivery).toBe("failed"));
  expect(client.getQueryData<Page>(["task-messages", "other"])?.items.some(item => item.contentText === "Original task payload")).not.toBe(true);
  expect(transport.sends).toHaveLength(0);
});

it("synchronous send failure immediately releases resources and retains retryable content", async () => {
  transport.failSends(true);
  await setupSend();
  expect(client.getQueryData<Page>(["task-messages", "task"])?.items.find(item => item.contentText === "Keep this send")?.__delivery).toBe("failed");
  expect(transport.listeners.get("disconnect")?.size).toBe(1);
  expect(transport.listeners.get("message:new")?.size).toBe(1);
});

it.each(["unmount", "task change"])("settles pending sends and removes their resources on %s", async reason => {
  const view = await setupSend();
  await act(async () => {
    if (reason === "unmount") view.unmount();
    else view.rerender(panel("other"));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(sendingMessage()?.__delivery).toBe("failed");
  expect(transport.listeners.get("disconnect")?.size ?? 0).toBe(reason === "unmount" ? 0 : 1);
  await act(async () => { transport.sends[0].ack({ ok: false }); await vi.advanceTimersByTimeAsync(10000); });
  expect(transport.sends).toHaveLength(1);
});
const panel = (taskId = "task") => <QueryClientProvider client={client}><TaskChatPanel taskId={taskId} /></QueryClientProvider>;
async function connect() {
  await act(async () => transport.receive("connect"));
  await act(async () => transport.joins.shift()!({ ok: true }));
}
async function setup() {
  const view = render(panel());
  await screen.findByText("Existing message");
  await connect();
  await waitFor(() => expect(readRequests).toHaveLength(1));
  await act(async () => transport.receive("disconnect"));
  readRequests = [];
  return view;
}

it("loads missed messages before marking their IDs read, without refetching for each live message", async () => {
  await setup();
  const before = getCount;
  page = { items: [...page.items, message("missed", "Arrived while disconnected")], nextCursor: null };
  await connect();
  await screen.findByText("Arrived while disconnected");
  await waitFor(() => expect(readRequests).toEqual([{ url: "/api/tasks/task/messages/read", body: { messageIds: ["old", "missed"] } }]));
  expect(getCount).toBe(before + 1);
  await act(async () => transport.receive("message:new", message("live", "Live delivery")));
  expect(await screen.findByText("Live delivery")).toBeVisible();
  expect(getCount).toBe(before + 1);
  expect(readRequests).toHaveLength(1);
});

it("does not mark read while a refresh is pending or after it fails", async () => {
  await setup();
  let finish!: (result: Response) => void;
  response = () => new Promise(resolve => { finish = resolve; });
  await connect();
  expect(readRequests).toEqual([]);
  await act(async () => finish(Response.json({ message: "Unavailable" }, { status: 503 })));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(readRequests).toEqual([]);
  expect(screen.getByText("Existing message")).toBeVisible();
});

it.each(["disconnect", "unmount", "task change"])("does not mark read after %s cancels a pending catch-up", async reason => {
  const view = await setup();
  const pending: ((result: Response) => void)[] = [];
  response = () => new Promise(resolve => { pending.push(resolve); });
  await connect();
  expect(readRequests).toEqual([]);
  if (reason === "disconnect") await act(async () => transport.receive("disconnect"));
  if (reason === "unmount") view.unmount();
  if (reason === "task change") view.rerender(panel("other"));
  await act(async () => { for (const finish of pending) finish(Response.json({ success: true, data: page })); });
  expect(readRequests).toEqual([]);
});

it("keeps unresolved local delivery and reconciles confirmed client IDs when snapshots refresh", async () => {
  await setup();
  await act(async () => client.setQueryData<Page>(["task-messages", "task"], {
    ...page, items: [...page.items,
      { ...message("optimistic_pending", "Pending local"), clientId: "pending", __delivery: "pending" },
      { ...message("optimistic_failed", "Failed local"), clientId: "failed", __delivery: "failed" },
      { ...message("optimistic_confirmed", "Confirmed local"), clientId: "confirmed", __delivery: "pending" },
    ],
  }));
  page = { items: [...page.items, { ...message("confirmed", "Confirmed local"), clientId: "confirmed" }], nextCursor: null };
  await connect();
  await waitFor(() => expect(readRequests).toHaveLength(1));
  expect(screen.getByText("Pending local")).toBeVisible();
  expect(screen.getByText("Failed local")).toBeVisible();
  expect(screen.getAllByText("Confirmed local")).toHaveLength(1);
  expect(client.getQueryData<Page>(["task-messages", "task"])?.items.map(item => item.id)).toEqual(["old", "confirmed", "optimistic_pending", "optimistic_failed"]);
  expect(readRequests[0].body).toEqual({ messageIds: ["old", "confirmed"] });
});

it("replays live creates and deletes received while the reconnect snapshot is in flight", async () => {
  page.items.push(message("deleted", "Deleted during refresh"));
  await setup();
  let finish!: (result: Response) => void;
  response = () => new Promise(resolve => { finish = resolve; });
  await connect();
  await act(async () => client.setQueryData<Page>(["task-messages", "task"], current => ({
    ...current!, items: [...current!.items, {
      ...message("optimistic_inflight", "Confirmed during refresh"),
      clientId: "inflight", __delivery: "pending",
    }],
  })));
  await act(async () => {
    transport.receive("message:new", message("live", "New during refresh"));
    transport.receive("message:new", { ...message("confirmed_inflight", "Confirmed during refresh"), clientId: "inflight" });
    transport.receive("message:deleted", { taskId: "task", messageId: "deleted" });
  });
  await act(async () => finish(Response.json({ success: true, data: page })));
  await waitFor(() => expect(readRequests).toHaveLength(1));
  expect(screen.getByText("New during refresh")).toBeVisible();
  expect(screen.queryByText("Deleted during refresh")).toBeNull();
  expect(screen.getAllByText("Confirmed during refresh")).toHaveLength(1);
  const confirmed = client.getQueryData<Page>(["task-messages", "task"])?.items.filter(item => item.clientId === "inflight");
  expect(confirmed).toEqual([{ ...message("confirmed_inflight", "Confirmed during refresh"), clientId: "inflight" }]);
});

it("reloads canonical content and reactions instead of applying reversed update snapshots", async () => {
  await setup();
  await connect();
  const before = getCount;
  page = { items: [{ ...message("old", "Canonical edit"), reactions: { "👍": ["a", "b"] } }], nextCursor: null };
  await act(async () => {
    transport.receive("message:updated", page.items[0]);
    transport.receive("message:updated", { ...message("old", "Stale edit"), reactions: { "👍": ["a"] } });
  });
  expect(await screen.findByText("Canonical edit")).toBeVisible();
  expect(client.getQueryData<Page>(["task-messages", "task"])?.items[0].reactions).toEqual({ "👍": ["a", "b"] });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(getCount).toBe(before + 1);
  await act(async () => transport.receive("message:updated", message("foreign", "Other task", "other")));
  expect(getCount).toBe(before + 1);
});

it("replaces an initial uncached request and ignores its late stale response", async () => {
  let finish!: (result: Response) => void;
  response = () => new Promise(resolve => { finish = resolve; });
  render(panel());
  await waitFor(() => expect(getCount).toBe(1));
  const initialSignal = signals[0];
  response = undefined;
  page = { items: [message("old", "Fresh initial message")], nextCursor: null };
  await act(async () => transport.receive("message:updated", message("old", "Stale initial event")));
  expect(await screen.findByText("Fresh initial message")).toBeVisible();
  expect(initialSignal?.aborted).toBe(true);
  await act(async () => finish(Response.json({ success: true, data: { items: [message("old", "Old initial snapshot")], nextCursor: null } })));
  expect(screen.getByText("Fresh initial message")).toBeVisible();
  expect(getCount).toBe(2);
});

it("coalesces update bursts into a trailing canonical fetch without starving pending requests", async () => {
  await setup();
  const before = getCount;
  let finish!: (result: Response) => void;
  response = () => new Promise(resolve => { finish = resolve; });
  await act(async () => transport.receive("message:updated", message("old", "First stale update")));
  await waitFor(() => expect(getCount).toBe(before + 1));
  const runningSignal = signals.at(-1);
  await act(async () => {
    for (let index = 0; index < 20; index++) transport.receive("message:updated", message("old", `Stale burst ${index}`));
  });
  expect(runningSignal?.aborted).toBe(false);
  response = undefined;
  page = { items: [message("old", "Final canonical message")], nextCursor: null };
  await act(async () => finish(Response.json({ success: true, data: { items: [message("old", "Intermediate snapshot")], nextCursor: null } })));
  expect(await screen.findByText("Final canonical message")).toBeVisible();
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(getCount).toBe(before + 2);
});

it.each(["unmount", "task change"])("does not start a queued update refresh after %s", async reason => {
  const view = await setup();
  const before = getCount;
  await act(async () => {
    transport.receive("message:updated", message("old", "Ignored old task snapshot"));
    if (reason === "unmount") view.unmount();
    else view.rerender(panel("other"));
  });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(getCount).toBe(before + (reason === "task change" ? 1 : 0));
  expect(readRequests).toEqual([]);
});

it.each([0, 150])("canonically refreshes the visible 51-message window with %s additional missed messages", async missed => {
  const history = Array.from({ length: 51 + missed }, (_, index) => ({
    ...message(`history-${index}`, `History ${index}`),
    createdAt: new Date(Date.UTC(2026, 8, 14, 0, index)).toISOString(),
  }));
  page = { items: history.slice(0, 50), nextCursor: null };
  render(panel());
  await screen.findByText("History 0");
  await act(async () => transport.receive("message:new", history[50]));
  await screen.findByText("History 50");
  const older = Array.from({ length: 10 }, (_, index) => ({
    ...message(`older-${index}`, `Earlier ${index}`),
    createdAt: new Date(Date.UTC(2026, 8, 13, 23, index)).toISOString(),
  }));
  const canonical = [...older, ...history].filter(item => !missed || item.id !== "history-1").map(item => item.id === "history-0"
    ? { ...item, contentText: "Oldest updated canonically", reactions: { "👍": ["user"] } }
    : item);
  const before = getCount;
  const requestedCursors: (string | null)[] = [];
  response = async url => {
    const params = new URL(url, "http://localhost").searchParams;
    const cursor = params.get("cursor");
    requestedCursors.push(cursor);
    const descending = [...canonical].reverse();
    const start = cursor ? descending.findIndex(item => item.id === cursor) + 1 : 0;
    const limit = Number(params.get("limit"));
    const items = descending.slice(start, start + limit);
    return Response.json({ success: true, data: {
      items: items.reverse(), nextCursor: start + limit < descending.length ? items[0].id : null,
    } });
  };
  await act(async () => transport.receive("message:updated", message("history-0", "Stale event")));
  expect(await screen.findByText("Oldest updated canonically")).toBeVisible();
  expect(screen.getByText("History 50")).toBeVisible();
  if (missed) expect(screen.queryByText("History 1")).toBeNull();
  expect(client.getQueryData<Page>(["task-messages", "task"])?.items).toHaveLength(missed ? 50 + missed : 51);
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(getCount - before).toBe(missed ? 3 : 2);
  expect(new Set(requestedCursors).size).toBe(requestedCursors.length);
  expect(screen.queryByText("Earlier 9")).toBeNull();
  await act(async () => transport.receive("message:updated", message("history-0", "Another stale event")));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(client.getQueryData<Page>(["task-messages", "task"])?.items).toHaveLength(missed ? 50 + missed : 51);
  expect(screen.queryByText("Earlier 9")).toBeNull();
});

it.each([false, true])("ignores delayed creation snapshots for confirmed messages during refetch=%s", async inFlight => {
  const confirmed = { ...message("confirmed", "Edited canonical content"), clientId: "sent-client", reactions: { "👍": ["user", "other"] } };
  page = { items: [confirmed], nextCursor: null };
  render(panel());
  await screen.findByText("Edited canonical content");
  let finish!: (value: Response) => void;
  if (inFlight) response = () => new Promise(resolve => { finish = resolve; });
  await connect();
  const before = getCount;
  await act(async () => {
    transport.receive("message:new", { ...message("confirmed", "Original stale creation"), clientId: "sent-client" });
    transport.receive("message:new", message("foreign", "Unrelated task creation", "other"));
    transport.receive("message:new", message("ordinary", "Ordinary new message"));
    transport.receive("message:new", message("ordinary", "Ordinary new message"));
  });
  if (inFlight) await act(async () => finish(Response.json({ success: true, data: page })));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(await screen.findByText("Edited canonical content")).toBeVisible();
  expect(screen.queryByText("Original stale creation")).toBeNull();
  expect(screen.queryByText("Unrelated task creation")).toBeNull();
  expect(screen.getAllByText("Ordinary new message")).toHaveLength(1);
  const cached = client.getQueryData<Page>(["task-messages", "task"]);
  expect(cached?.items).toHaveLength(2);
  expect(cached?.items.find(item => item.id === "confirmed")).toEqual(confirmed);
  expect(getCount).toBe(before);
});

it.each(["pending", "failed"] as const)("still confirms %s optimistic delivery by client ID", async delivery => {
  client.setQueryData<Page>(["task-messages", "task"], {
    items: [{ ...message("optimistic_sent", "Local message"), clientId: "sent", __delivery: delivery }], nextCursor: null,
  });
  render(panel());
  await screen.findByText("Local message");
  await act(async () => transport.receive("message:new", { ...message("server-sent", "Confirmed message"), clientId: "sent" }));
  expect(await screen.findByText("Confirmed message")).toBeVisible();
  expect(screen.queryByText("Local message")).toBeNull();
  expect(client.getQueryData<Page>(["task-messages", "task"])?.items).toEqual([
    { ...message("server-sent", "Confirmed message"), clientId: "sent", __delivery: undefined },
  ]);
});

it("removes an optimistic sibling while keeping the existing canonical message authoritative", async () => {
  const confirmed = { ...message("confirmed", "Canonical edited sibling"), clientId: "same-client", reactions: { "👍": ["user"] } };
  client.setQueryData<Page>(["task-messages", "task"], { items: [
    confirmed,
    { ...message("optimistic_sibling", "Unresolved sibling"), clientId: "same-client", __delivery: "pending" },
  ], nextCursor: null });
  render(panel());
  await screen.findByText("Canonical edited sibling");
  await act(async () => transport.receive("message:new", { ...message("confirmed", "Stale sibling creation"), clientId: "same-client" }));
  await waitFor(() => expect(screen.queryByText("Unresolved sibling")).toBeNull());
  expect(screen.getByText("Canonical edited sibling")).toBeVisible();
  expect(client.getQueryData<Page>(["task-messages", "task"])?.items).toEqual([confirmed]);
});
