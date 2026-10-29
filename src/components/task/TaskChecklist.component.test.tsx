import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/telemetry/client", async () => ({
  ...await vi.importActual("@/lib/telemetry/client"),
  getBrowserTelemetryClient: () => bridge.current,
}));
import { TelemetryClient } from "@/lib/telemetry/client";
import { TaskChecklist } from "./TaskChecklist";

const TEXT = "synthetic-private-checklist-text-token-cookie";
const SESSION_EXPIRY = "2026-10-21T12:00:00.000Z";
const PROOF = `v1.${Date.parse(SESSION_EXPIRY)}.${"a".repeat(64)}`;
const REQUEST_ID = "c12bc345-6789-4abc-8def-012345678901";
const ERROR_ID = "d12bc345-6789-4abc-8def-012345678901";
const item = { id: "item-1", taskId: "task-1", text: TEXT, completed: false, position: 0, createdAt: "2026-10-20T12:00:00Z", updatedAt: "2026-10-20T12:00:00Z" };
const clients: QueryClient[] = [];
const queues: TelemetryClient[] = [];
const fetchMock = vi.fn<typeof fetch>();
let logs: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  logs = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
});
afterEach(() => {
  cleanup();
  queues.splice(0).forEach(queue => queue.dispose());
  clients.splice(0).forEach(client => client.clear());
  bridge.current = null;
  logs.forEach(log => log.mockRestore());
  vi.unstubAllGlobals();
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function installFetch(business: (url: string, options?: RequestInit) => Promise<Response>, initStatus = 200) {
  fetchMock.mockImplementation(async (url, options) => {
    if (String(url) === "/api/telemetry") {
      const body = JSON.parse(String(options?.body));
      if (body.kind === "session.start") return Response.json({ success: true, data: { sessionId: body.sessionId, sessionToken: PROOF, expiresAt: SESSION_EXPIRY } }, { status: initStatus });
      return Response.json({ success: true, data: { accepted: body.events.map((event: { eventId: string }) => event.eventId) } });
    }
    expect(String(url)).toMatch(/^\/api\/tasks\/task-1\/checklist(?:\/item-1)?$/);
    return business(String(url), options);
  });
}
async function queueReady() {
  let seq = 0;
  const queue = new TelemetryClient({ fetch: fetchMock, uuid: () => `${(++seq).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`, wallClock: () => new Date("2026-10-20T12:00:00.000Z") });
  queues.push(queue);
  bridge.current = queue;
  await queue.setIdentity("synthetic-actor");
  return queue;
}
function mount() {
  const changed = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  function Harness() {
    const [items, setItems] = React.useState([item]);
    return <TaskChecklist taskId="task-1" items={items} onUpdate={next => { changed(next); setItems(next); }} />;
  }
  const tree = () => <QueryClientProvider client={client}><Harness /></QueryClientProvider>;
  const view = render(tree());
  return { changed, rerender: () => view.rerender(tree()) };
}
function checkbox() { return screen.getByRole("checkbox", { name: `Отметить пункт: ${TEXT}` }); }
function businessCalls() { return fetchMock.mock.calls.filter(([url]) => String(url) !== "/api/telemetry"); }
function telemetryEvents() {
  return fetchMock.mock.calls.filter(([url, options]) => String(url) === "/api/telemetry" && !String(options?.body).includes('"kind":"session.start"'))
    .flatMap(([, options]) => JSON.parse(String(options?.body)).events);
}

it("one real checkbox PATCH produces one intent/result with matching correlation and no private text in telemetry or console", async () => {
  installFetch(async () => Response.json({ success: true, data: { ...item, completed: true } }, { headers: { "X-Request-Id": REQUEST_ID } }));
  const queue = await queueReady();
  const begin = vi.spyOn(queue, "beginAction");
  const finish = vi.spyOn(queue, "finishAction");
  const view = mount();
  view.rerender();
  expect(begin).not.toHaveBeenCalled();
  fireEvent.click(checkbox());
  await waitFor(() => expect(view.changed).toHaveBeenCalledTimes(1));
  expect(checkbox()).toHaveAttribute("data-state", "checked");
  expect(begin).toHaveBeenCalledTimes(1);
  expect(finish).toHaveBeenCalledTimes(1);
  expect(businessCalls()).toHaveLength(1);
  const init = businessCalls()[0][1]!;
  expect(JSON.parse(String(init.body))).toEqual({ completed: true });
  const headers = new Headers(init.headers);
  expect(headers.get("X-Action-Id")).toBe(begin.mock.results[0].value?.actionId);
  expect(headers.get("X-Operation-Id")).toBe(begin.mock.results[0].value?.operationId);
  await act(async () => queue.flush());
  const events = telemetryEvents();
  expect(events.map(event => event.event)).toEqual(["ui.action", "client.request.result"]);
  expect(events[0].actionId).toBe(events[1].actionId);
  expect(events[1]).toMatchObject({ requestId: REQUEST_ID, outcome: "success", statusCode: 200 });
  expect(JSON.stringify(events)).not.toMatch(/synthetic-private|cookie|token|completed|text|payload/);
  expect(JSON.stringify(logs.flatMap(log => log.mock.calls))).not.toContain(TEXT);
  view.rerender();
  expect(begin).toHaveBeenCalledTimes(1);
});

it("prevents a second pending checkbox/text/keyboard toggle without losing the first update", async () => {
  const response = deferred<Response>();
  installFetch(async () => response.promise);
  const queue = await queueReady();
  const begin = vi.spyOn(queue, "beginAction");
  const view = mount();
  fireEvent.click(checkbox());
  fireEvent.click(checkbox());
  fireEvent.click(screen.getByText(TEXT));
  fireEvent.keyDown(screen.getByText(TEXT), { key: "Enter" });
  expect(checkbox()).toBeDisabled();
  expect(screen.getByText(TEXT)).toHaveAttribute("aria-disabled", "true");
  expect(businessCalls()).toHaveLength(1);
  expect(begin).toHaveBeenCalledTimes(1);
  expect(view.changed).not.toHaveBeenCalled();
  await act(async () => response.resolve(Response.json({ success: true, data: { ...item, completed: true } })));
  await waitFor(() => expect(view.changed).toHaveBeenCalledTimes(1));
  expect(checkbox()).not.toBeDisabled();
});

it("keeps the business toggle working when the telemetry collector cannot initialize", async () => {
  installFetch(async () => Response.json({ success: true, data: { ...item, completed: true } }), 503);
  const queue = await queueReady();
  expect(queue.beginAction()).toBeNull();
  const view = mount();
  fireEvent.click(checkbox());
  await waitFor(() => expect(view.changed).toHaveBeenCalledTimes(1));
  expect(checkbox()).toHaveAttribute("data-state", "checked");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(telemetryEvents()).toHaveLength(0);
});

it("renders a static business failure while the real API callback reports a safe correlated failure", async () => {
  installFetch(async () => Response.json({ error: { message: TEXT, details: { password: "synthetic-private-password" } } }, { status: 500, headers: { "X-Request-Id": REQUEST_ID, "X-Error-Id": ERROR_ID } }));
  const queue = await queueReady();
  const view = mount();
  fireEvent.click(checkbox());
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Не удалось изменить пункт. Повторите попытку.");
  expect(alert).not.toHaveTextContent(TEXT);
  expect(view.changed).not.toHaveBeenCalled();
  await act(async () => queue.flush());
  expect(telemetryEvents().find(event => event.event === "client.request.result")).toMatchObject({ outcome: "failure", statusCode: 500, requestId: REQUEST_ID, errorId: ERROR_ID });
  expect(JSON.stringify(telemetryEvents())).not.toMatch(/synthetic-private|password|details|message/);
  expect(JSON.stringify(logs.flatMap(log => log.mock.calls))).not.toContain(TEXT);
});

it("editing text alone creates no telemetry intent or HTTP request", async () => {
  installFetch(async () => Response.json({ success: true, data: item }));
  const queue = await queueReady();
  const begin = vi.spyOn(queue, "beginAction");
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Редактировать" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "synthetic-private-new-text" } });
  expect(begin).not.toHaveBeenCalled();
  expect(businessCalls()).toHaveLength(0);
  await queue.flush();
  expect(telemetryEvents()).toHaveLength(0);
});

it("blocks add/edit/delete while a toggle is pending, then preserves a newly added item", async () => {
  const toggle = deferred<Response>();
  const added = { ...item, id: "item-2", text: "Synthetic new item Y" };
  installFetch(async url => url.endsWith("/item-1") ? toggle.promise : Response.json({ success: true, data: added }));
  await queueReady();
  const view = mount();
  fireEvent.click(screen.getByRole("button", { name: "Добавить пункт" }));
  fireEvent.change(screen.getByPlaceholderText("Текст пункта..."), { target: { value: added.text } });
  fireEvent.click(checkbox());
  const add = screen.getByRole("button", { name: "Добавить элемент" });
  const remove = screen.getByRole("button", { name: "Удалить" });
  const edit = screen.getByRole("button", { name: "Редактировать" });
  fireEvent.click(add);
  fireEvent.click(remove);
  fireEvent.click(edit);
  fireEvent.keyDown(screen.getByPlaceholderText("Текст пункта..."), { key: "Enter" });
  expect(add).toBeDisabled();
  expect(remove).toBeDisabled();
  expect(edit).toBeDisabled();
  expect(businessCalls()).toHaveLength(1);
  await act(async () => toggle.resolve(Response.json({ success: true, data: { ...item, completed: true } })));
  await waitFor(() => expect(view.changed).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Добавить элемент" }));
  await screen.findByText(added.text);
  expect(view.changed).toHaveBeenCalledTimes(2);
  expect(view.changed.mock.calls[1][0]).toEqual([{ ...item, completed: true }, added]);
  expect(checkbox()).toHaveAttribute("data-state", "checked");
});

it("blocks reciprocal toggles and duplicate submissions while adding, preserving both existing and new items", async () => {
  const response = deferred<Response>();
  const added = { ...item, id: "item-2", text: "Synthetic retained item Y" };
  installFetch(async () => response.promise);
  const queue = await queueReady();
  const begin = vi.spyOn(queue, "beginAction");
  const view = mount();
  fireEvent.click(screen.getByRole("button", { name: "Добавить пункт" }));
  fireEvent.change(screen.getByPlaceholderText("Текст пункта..."), { target: { value: added.text } });
  fireEvent.click(screen.getByRole("button", { name: "Добавить элемент" }));
  fireEvent.click(screen.getByRole("button", { name: "Добавить элемент" }));
  fireEvent.keyDown(screen.getByPlaceholderText("Текст пункта..."), { key: "Enter" });
  fireEvent.click(checkbox());
  fireEvent.click(screen.getByText(TEXT));
  fireEvent.keyDown(screen.getByText(TEXT), { key: " " });
  expect(checkbox()).toBeDisabled();
  expect(businessCalls()).toHaveLength(1);
  expect(businessCalls()[0][1]?.method).toBe("POST");
  expect(begin).not.toHaveBeenCalled();
  await act(async () => response.resolve(Response.json({ success: true, data: added })));
  await screen.findByText(added.text);
  expect(view.changed).toHaveBeenCalledExactlyOnceWith([item, added]);
  expect(checkbox()).toHaveAttribute("data-state", "unchecked");
});
