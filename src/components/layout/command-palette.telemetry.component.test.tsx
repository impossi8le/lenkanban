import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/telemetry/client", async () => ({
  ...await vi.importActual("@/lib/telemetry/client"),
  getBrowserTelemetryClient: () => bridge.current,
}));
const nav = vi.hoisted(() => ({ pathname: "/inbox", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: nav.push }),
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: "test-actor" } } }) }));
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: api.fetch }));

import { TelemetryClient } from "@/lib/telemetry/client";
import { CommandPalette } from "./command-palette";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const PROOF = `v1.${NOW.getTime() + 3_600_000}.${"a".repeat(64)}`;
const PRIVATE_QUERY = "PRIVATE-SEARCH-STRING";

const queues: TelemetryClient[] = [];
const clients: QueryClient[] = [];
const fetchMock = vi.fn<typeof fetch>();
const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

beforeEach(() => {
  nav.pathname = "/inbox";
  nav.push.mockReset();
  api.fetch.mockReset();
  api.fetch.mockResolvedValue([]);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { kind?: string; sessionId?: string; events?: Array<{ eventId: string }> };
    if (body.kind === "session.start") {
      return Response.json({ success: true, data: { sessionId: body.sessionId, sessionToken: PROOF, expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString() } });
    }
    return Response.json({ success: true, data: { accepted: (body.events ?? []).map(event => event.eventId) } });
  });
  // cmdk calls scrollIntoView; jsdom has no layout engine.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  queues.splice(0).forEach(queue => queue.dispose());
  clients.splice(0).forEach(client => client.clear());
  bridge.current = null;
  if (previousScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", previousScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function telemetryEvents() {
  return fetchMock.mock.calls
    .filter(([url, options]) => String(url) === "/api/telemetry" && !String(options?.body).includes('"kind":"session.start"'))
    .flatMap(([, options]) => (JSON.parse(String(options?.body)) as { events: Array<Record<string, unknown>> }).events);
}

async function setup() {
  let seq = 0;
  const queue = new TelemetryClient({
    fetch: fetchMock,
    wallClock: () => NOW,
    clock: () => 0,
    uuid: () => `${(++seq).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
  });
  queues.push(queue);
  bridge.current = queue;
  await queue.setIdentity("synthetic-actor");

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const element = () => <QueryClientProvider client={client}><CommandPalette /></QueryClientProvider>;
  const view = render(element());
  fireEvent.click(screen.getByRole("button", { name: "Поиск обращений и направлений" }));
  await screen.findByRole("dialog", { name: "Поиск обращений и направлений" });
  return { queue, rerender: () => view.rerender(element()) };
}

describe("command palette telemetry", () => {
  it("records the fact of a search without the query string", async () => {
    const { queue } = await setup();
    const input = screen.getByPlaceholderText("Найти обращение или направление…");
    fireEvent.change(input, { target: { value: PRIVATE_QUERY } });
    await waitFor(() => expect(telemetryEvents()).toHaveLength(1));
    await queue.flush();
    const events = telemetryEvents();
    expect(events[0]).toMatchObject({ event: "ui.action", action: "board.search" });
    expect(Object.keys(events[0]).sort()).toEqual([
      "action", "actionId", "event", "eventId", "occurredAt", "schemaVersion", "seq", "sessionId", "traceId",
    ]);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(PRIVATE_QUERY);
    // The search itself still reaches the API with its own query string.
    expect(api.fetch.mock.calls.some(([url]) => String(url).includes("search=PRIVATE-SEARCH-STRING"))).toBe(true);
  });

  it("does not repeat the search intent on rerender or on a sub-minimum query", async () => {
    const { queue, rerender } = await setup();
    const input = screen.getByPlaceholderText("Найти обращение или направление…");
    fireEvent.change(input, { target: { value: "a" } });
    await new Promise(resolve => setTimeout(resolve, 250));
    rerender();
    expect(telemetryEvents()).toHaveLength(0);
    fireEvent.change(input, { target: { value: PRIVATE_QUERY } });
    await waitFor(() => expect(telemetryEvents()).toHaveLength(1));
    rerender();
    rerender();
    await queue.flush();
    expect(telemetryEvents()).toHaveLength(1);
  });

  it("does not emit events for the removed navigation, view or theme commands", async () => {
    const { queue } = await setup();
    for (const text of ["Главная", "Запросы в отделы", "Настройки", "Доска", "Таблица", "Календарь", "Тема"]) {
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    }
    await queue.flush();
    expect(telemetryEvents()).toHaveLength(0);
    expect(nav.push).not.toHaveBeenCalled();
  });
});
