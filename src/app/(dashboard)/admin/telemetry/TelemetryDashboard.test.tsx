// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetryErrorDetail, TelemetryReportEvent, TelemetrySummary } from "@/lib/telemetry/report-contract";

const mocks = vi.hoisted(() => ({ api: vi.fn(), user: vi.fn(), notFound: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: mocks.user, isGlobalAdmin: (user: { globalRole: string }) => user.globalRole === "ADMIN" }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
import TelemetryDashboard from "./TelemetryDashboard";
import AdminTelemetryPage, { dynamic } from "./page";

const now = "2026-10-20T12:00:00.000Z";
const from = "2026-10-19T12:00:00.000Z";
const errorId = "00000000-0000-4000-8000-000000000001";
const actionId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
function summary(overrides: Partial<TelemetrySummary> = {}): TelemetrySummary {
  return { window: { from, to: now, timezone: "UTC" }, collection: { state: "available", coverage: ["task.checklist.toggle", "app.render"], observedRows: 1, limit: 10000, truncated: false, latestReceivedAt: now, collectorHealth: "not_measured" },
    usage: { uniqueActions: 3, clientSessions: 2, clientActors: 1, committedChanges: 4 }, diagnostics: { requestCount: 20, failedRequestCount: 2, rejectedRequestCount: 3, conflictRequestCount: 1, failureRate: 0.1, clientFailures: 9, clientCancellations: 2, renderFailures: 1 }, ...overrides };
}
function row(id = "row-one", overrides: Partial<TelemetryReportEvent> = {}): TelemetryReportEvent {
  return { id, actorKey: `v1:${"a".repeat(64)}`, eventId: actionId, receivedAt: now, occurredAt: now, event: "api.request.completed", category: "diagnostic", source: "server", trust: "server_observed", requestId, actionId, errorId, payload: { schemaVersion: 1, statusCode: 500, outcome: "failure" }, ...overrides };
}
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><TelemetryDashboard serverNow={now} /></QueryClientProvider>);
  return client;
}
function eventCalls() { return mocks.api.mock.calls.map(call => String(call[0])).filter(url => url.startsWith("/api/admin/telemetry?")); }
function path(url: string) { return new URL(url, "https://test.invalid"); }
beforeEach(() => {
  mocks.api.mockReset(); mocks.user.mockReset(); mocks.notFound.mockReset();
  mocks.notFound.mockImplementation(() => { throw new Error("NOT_FOUND_SENTINEL"); });
  mocks.api.mockImplementation(async (url: string) => url.includes("/summary?") ? summary() : { items: [], nextCursor: null });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

describe("telemetry page server gate", () => {
  it("is dynamic and rejects a current non-admin before rendering client", async () => {
    mocks.user.mockResolvedValue({ globalRole: "USER" });
    expect(dynamic).toBe("force-dynamic");
    await expect(AdminTelemetryPage()).rejects.toThrow("NOT_FOUND_SENTINEL");
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it("propagates unauthenticated rejection without loading report data", async () => {
    mocks.user.mockRejectedValue(new Error("Unauthorized"));
    await expect(AdminTelemetryPage()).rejects.toThrow("Unauthorized");
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it("renders dashboard only for actual global admin", async () => {
    mocks.user.mockResolvedValue({ globalRole: "ADMIN" });
    const result = await AdminTelemetryPage();
    expect(result.type).toBe(TelemetryDashboard);
    expect(Number.isFinite(Date.parse(result.props.serverNow))).toBe(true);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });
});

describe("telemetry dashboard", () => {
  it.each(["disabled", "unconfigured"] as const)("labels %s without requesting events or displaying zero metrics", async state => {
    const data = summary(); data.collection.state = state;
    mocks.api.mockResolvedValue(data); mount();
    await screen.findByText(state === "disabled" ? "Сбор телеметрии выключен." : "Сбор телеметрии не настроен.");
    expect(eventCalls()).toHaveLength(0);
    expect(screen.queryByText("Серверные запросы")).toBeNull();
    expect(screen.getByRole("heading", { name: "Ошибки и состояние системы" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Использование функций" })).toBeTruthy();
  });
  it("keeps the report heading hierarchy without skipped levels", async () => {
    mount(); await screen.findByText("Серверные запросы");
    expect(screen.getByRole("heading", { name: "Телеметрия" }).tagName).toBe("H1");
    expect(screen.getByRole("heading", { name: "Ошибки и состояние системы" }).tagName).toBe("H2");
    expect(screen.getByRole("heading", { name: "Использование функций" }).tagName).toBe("H2");
    expect(screen.getByRole("heading", { name: "События" }).tagName).toBe("H2");
  });
  it("distinguishes initial unavailable state from no data and retries", async () => {
    mocks.api.mockRejectedValueOnce(Object.assign(new Error("PRIVATE_RAW_ERROR"), { status: 503 })); mount();
    await screen.findByRole("alert");
    expect(screen.getByText(/Состояние сбора неизвестно/)).toBeTruthy();
    expect(screen.queryByText(/PRIVATE_RAW_ERROR/)).toBeNull();
    expect(screen.queryByText("За выбранный период событий нет.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByText("Серверные запросы");
  });
  it("retains loaded metrics on a failed summary refetch", async () => {
    const client = mount(); await screen.findByText("Серверные запросы");
    mocks.api.mockImplementation(async (url: string) => { if (url.includes("summary?")) throw new Error("network"); return { items: [], nextCursor: null }; });
    await act(async () => { await client.refetchQueries({ queryKey: ["adminTelemetryReport", "summary"] }); });
    await screen.findByText(/Показаны ранее загруженные данные/);
    expect(screen.getByText("Серверные запросы")).toBeTruthy();
  });
  it("shows no events, a receipt gap, and unmeasured health without inventing zeros", async () => {
    const data = summary(); data.collection.observedRows = 0; data.collection.latestReceivedAt = null;
    mocks.api.mockImplementation(async (url: string) => url.includes("summary?") ? data : { items: [], nextCursor: null }); mount();
    await screen.findByText("За выбранный период событий нет.");
    expect(screen.getByText(/Это не подтверждает сбой сборщика/)).toBeTruthy();
    expect(screen.getByText(/Здоровье сборщика.*не измеряются/)).toBeTruthy();
  });
  it("uses server failure ratio independently of client failures", async () => {
    mount(); await screen.findByText("10.0%");
    expect(screen.getByText("Ошибки запросов по сообщениям клиента").nextElementSibling?.textContent).toBe("9");
    expect(screen.getByText("Подтверждённые изменения (серверные операции)").nextElementSibling?.textContent).toBe("4");
  });
  it.each(["none", "truncated"])("does not calculate a misleading failure ratio: %s", async mode => {
    const data = summary(); if (mode === "none") { data.diagnostics.requestCount = 0; data.diagnostics.failureRate = null; } else data.collection.truncated = true;
    mocks.api.mockImplementation(async (url: string) => url.includes("summary?") ? data : { items: [], nextCursor: null }); mount();
    await screen.findByText("Не рассчитывается");
    if (mode === "none") expect(screen.getByText(/Недостаточная выборка/)).toBeTruthy();
    else expect(screen.getByText(/Выборка ограничена/)).toBeTruthy();
  });
  it("anchors event cursors to the returned server window and disables exhausted paging", async () => {
    const data = summary(); data.window.from = "2026-10-19T13:00:00.000Z";
    mocks.api.mockImplementation(async (url: string) => url.includes("summary?") ? data : { items: [], nextCursor: null }); mount();
    await screen.findByText("События не найдены.");
    const params = path(eventCalls()[0]).searchParams;
    expect(params.get("from")).toBe(data.window.from); expect(params.get("to")).toBe(now);
    expect((screen.getByRole("button", { name: "Всё загружено" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("retains rows on next-page failure and retries the same cursor without duplicating rows", async () => {
    let nextAttempts = 0;
    mocks.api.mockImplementation(async (url: string) => {
      if (url.includes("summary?")) return summary();
      if (path(url).searchParams.has("cursor")) { if (++nextAttempts === 1) throw new Error("network"); return { items: [row(), row("row-two", { receivedAt: from })], nextCursor: null }; }
      return { items: [row()], nextCursor: "cursor-one" };
    }); mount(); await screen.findByRole("button", { name: "Загрузить ещё" });
    fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё" })); await screen.findByRole("alert");
    expect(screen.getAllByRole("button", { name: errorId })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: errorId })).toHaveLength(2));
    expect(eventCalls().filter(url => path(url).searchParams.get("cursor") === "cursor-one")).toHaveLength(2);
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });
  it("suppresses parallel next-page clicks while pending and restores focus after exhaustion", async () => {
    let resolve!: (value: unknown) => void;
    mocks.api.mockImplementation(async (url: string) => url.includes("summary?") ? summary() : path(url).searchParams.has("cursor") ? new Promise(r => { resolve = r; }) : { items: [row()], nextCursor: "next" });
    mount(); const button = await screen.findByRole("button", { name: "Загрузить ещё" }); button.focus(); fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true)); fireEvent.click(button);
    expect(eventCalls().filter(url => path(url).searchParams.has("cursor"))).toHaveLength(1);
    await act(async () => { resolve({ items: [], nextCursor: null }); });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Список событий")));
  });
  it("resets cursor pages on category changes, including return to a cached category", async () => {
    mocks.api.mockImplementation(async (url: string) => url.includes("summary?") ? summary() : { items: [], nextCursor: "next" }); mount();
    await screen.findByRole("button", { name: "Загрузить ещё" });
    fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё" }));
    await waitFor(() => expect(eventCalls().some(url => path(url).searchParams.has("cursor"))).toBe(true));
    fireEvent.change(screen.getByLabelText("Раздел"), { target: { value: "usage" } });
    await waitFor(() => expect(path(eventCalls().at(-1)!).searchParams.get("category")).toBe("usage"));
    fireEvent.change(screen.getByLabelText("Раздел"), { target: { value: "diagnostic" } });
    await waitFor(() => expect(path(eventCalls().at(-1)!).searchParams.get("category")).toBe("diagnostic"));
    expect(path(eventCalls().at(-1)!).searchParams.has("cursor")).toBe(false);
  });
  it("submits and resets period/project/revision filters with explicit coverage caveat", async () => {
    mount(); await screen.findByText("Серверные запросы");
    fireEvent.change(screen.getByLabelText("Период, UTC"), { target: { value: "168" } });
    fireEvent.change(screen.getByLabelText("ID проекта"), { target: { value: "project-one" } });
    fireEvent.change(screen.getByLabelText("Ревизия (SHA)"), { target: { value: "abcdef1" } });
    fireEvent.click(screen.getByRole("button", { name: "Применить" }));
    await screen.findByText(/нулевые показатели не доказывают/);
    await waitFor(() => expect(mocks.api.mock.calls.some(([url]) => String(url).includes("projectId=project-one") && String(url).includes("revision=abcdef1"))).toBe(true));
    const latest = mocks.api.mock.calls.map(([url]) => String(url)).findLast(url => url.includes("summary?"))!;
    expect(path(latest).searchParams.get("from")).toBe("2026-10-13T12:00:00.000Z");
    fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    await waitFor(() => expect(screen.queryByText(/нулевые показатели не доказывают/)).toBeNull());
    expect((screen.getByLabelText("ID проекта") as HTMLInputElement).value).toBe("");
  });
  it("opens safe ordered error detail with honest linkage and returns focus on close", async () => {
    const detail: TelemetryErrorDetail = { errorId, linkage: "client_reported", truncated: true, events: [row()], breadcrumbs: [row("late", { occurredAt: now, payload: { schemaVersion: 1, action: "app.render" } }), row("early", { occurredAt: from, actionId: "UNSAFE <secret>", payload: { schemaVersion: 1, action: "PRIVATE_BODY_TEXT" } })] };
    mocks.api.mockImplementation(async (url: string) => url.includes("summary?") ? summary() : url.includes("/errors/") ? detail : { items: [row()], nextCursor: null }); mount();
    const trigger = await screen.findByRole("button", { name: errorId }); trigger.focus(); fireEvent.click(trigger);
    const panel = await screen.findByRole("region", { name: "Подробности ошибки" });
    await within(panel).findByText(/серверное подтверждение отсутствует/);
    expect(within(panel).getByRole("heading", { name: "Подробности ошибки" }).tagName).toBe("H3");
    expect(within(panel).getAllByRole("heading", { level: 4 })).toHaveLength(2);
    expect(document.activeElement).toBe(panel);
    expect(within(panel).getByText(/Цепочка ограничена/)).toBeTruthy();
    expect(screen.queryByText(/PRIVATE_BODY_TEXT/)).toBeNull(); expect(screen.queryByText(/UNSAFE/)).toBeNull();
    const crumbs = within(panel).getAllByRole("list")[1];
    expect(within(crumbs).getAllByRole("listitem")[0].textContent).toContain("Действие не указано");
    fireEvent.click(within(panel).getByRole("button", { name: "Закрыть" })); expect(document.activeElement).toBe(trigger);
    const request = mocks.api.mock.calls.map(([url]) => String(url)).find(url => url.includes("/errors/"))!;
    expect(path(request).searchParams.get("from")).toBe(from);
  });
});

it("shows a manual problem report with its reason and immutable safe timeline without claiming a server exception", async () => {
  const anchor = row("report", { event: "client.problem.reported", source: "client", trust: "client_reported", payload: { schemaVersion: 1, action: "app.problem.report", reason: "slow", screen: "home" } });
  const detail: TelemetryErrorDetail = { errorId, linkage: "client_reported", truncated: false, events: [anchor],
    problemReport: { reportId: errorId, reason: "slow", screen: "home", breadcrumbCount: 1, comment: '<img src=x onerror="synthetic()"> Мой комментарий\nВторая строка' },
    breadcrumbs: [row("snapshot", { event: "client.breadcrumb", source: "client", trust: "client_reported", payload: { schemaVersion: 1, action: "app.breadcrumb", kind: "request", name: "/api/tasks", durationMs: 123 } })] };
  mocks.api.mockImplementation(async (url: string) => url.includes("summary?") ? summary() : url.includes("/errors/") ? detail : { items: [anchor], nextCursor: null }); mount();
  fireEvent.click(await screen.findByRole("button", { name: errorId }));
  const panel = await screen.findByRole("region", { name: "Подробности ошибки" });
  await within(panel).findByRole("heading", { name: "Сообщение сотрудника" });
  const comment = within(panel).getByRole("region", { name: "Комментарий сотрудника" });
  expect(comment.textContent).toContain('<img src=x onerror="synthetic()"> Мой комментарий\nВторая строка');
  expect(comment.querySelector("img")).toBeNull();
  expect(within(panel).getByText("Медленно работает · Главная")).toBeInTheDocument();
  expect(within(panel).getByText(/не подтверждение серверной ошибки/)).toBeInTheDocument();
  expect(within(panel).getByText("Время: 123 мс")).toBeInTheDocument();
  expect(within(panel).getByRole("heading", { name: "События сообщения" })).toBeInTheDocument();
  expect(within(panel).queryByText("Подтверждено сервером")).not.toBeInTheDocument();
});


describe("stored request latency presentation", () => {
  function withLatency(groups: NonNullable<TelemetrySummary["requestLatency"]>["groups"] = []) {
    return summary({ requestLatency: { coverage: "partial_stored_observations", percentileMethod: "nearest_rank", slowThresholdMs: 1000, groups } });
  }
  it("keeps old summary responses compatible without inventing latency values", async () => {
    mount(); await screen.findByText("Серверные запросы");
    expect(screen.queryByRole("heading", { name: "Время запросов" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Задержки запросов по маршрутам и источникам" })).not.toBeInTheDocument();
  });
  it("shows an honest empty saved sample rather than zero percentiles", async () => {
    const data = withLatency();
    mocks.api.mockImplementation(async (url: string) => url.includes("/summary?") ? data : { items: [], nextCursor: null });
    mount(); await screen.findByText("Сохранённых наблюдений времени запросов за этот период нет.");
    expect(screen.queryByRole("table", { name: "Задержки запросов по маршрутам и источникам" })).not.toBeInTheDocument();
    expect(screen.getByText(/Частичная сохранённая выборка/)).toHaveTextContent("не статистика всех HTTP-запросов");
  });
  it("keeps source timings separate and discloses window, rank and truncated sample", async () => {
    const data = withLatency([
      { route: "/api/tasks", source: "client.observed", count: 5, p50Ms: 120, p95Ms: 1800, p99Ms: 2200, maxMs: 2200, slowCount: 2 },
      { route: "/api/tasks", source: "server.handler", count: 3, p50Ms: 50, p95Ms: 500, p99Ms: 500, maxMs: 500, slowCount: 0 },
    ]);
    data.collection.truncated = true; data.collection.observedRows = 10000;
    mocks.api.mockImplementation(async (url: string) => url.includes("/summary?") ? data : { items: [], nextCursor: null });
    mount(); const table = await screen.findByRole("table", { name: "Задержки запросов по маршрутам и источникам" });
    const rows = within(table).getAllByRole("row"); expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("Наблюдение клиента (браузер)");
    expect(within(rows[1]).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["Наблюдение клиента (браузер)", "5", "120 мс", "1800 мс", "2200 мс", "2200 мс", "2"]);
    expect(rows[2]).toHaveTextContent("Обработчик сервера"); expect(rows[2]).toHaveTextContent("500 мс");
    expect(screen.getByText(/Выборка времени запросов ограничена/)).toHaveTextContent("перцентили относятся только к сохранённым наблюдениям");
    expect(screen.getByText(/Окно:/)).toHaveTextContent("nearest rank");
    expect(screen.getByText(/Окно:/)).toHaveTextContent("1000 мс");
    expect(screen.getByText(/Полный журнал HTTP/)).toBeInTheDocument();
  });
});
