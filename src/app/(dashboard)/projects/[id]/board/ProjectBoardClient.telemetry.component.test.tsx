import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType, ReactNode } from "react";

const bridge = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/telemetry/client", async () => ({
  ...await vi.importActual("@/lib/telemetry/client"),
  getBrowserTelemetryClient: () => bridge.current,
}));
const nav = vi.hoisted(() => ({ search: "view=board", push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/project-1/board",
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
// Views and dialogs are split into their own chunks, so a dynamic component
// resolves through React.lazy instead of rendering synchronously.
vi.mock("next/dynamic", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    default: (loader: () => Promise<{ default: ComponentType<Record<string, unknown>> }>) => {
      const Lazy = React.lazy(loader);
      return function DynamicMock(props: Record<string, unknown>) {
        return React.createElement(
          React.Suspense,
          { fallback: null },
          React.createElement(Lazy, props),
        );
      };
    },
  };
});
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn().mockResolvedValue({ id: "project-1", name: "Project" }) }));
vi.mock("@/lib/socket-client", () => ({ getSocketInstance: () => ({ on: vi.fn(), off: vi.fn() }) }));
vi.mock("@/components/kanban/Board", () => ({ KanbanBoard: () => <div>Board content</div> }));
vi.mock("@/components/views/TableView", () => ({ TableView: () => <div>Table content</div> }));
vi.mock("@/components/task/CreateTaskDialog", () => ({ CreateTaskDialog: () => null }));
vi.mock("@/components/kanban/BoardOptionsMenu", () => ({ BoardOptionsMenu: () => null }));
vi.mock("@/components/project/ProjectMembersDialog", () => ({ ProjectMembersDialog: () => null }));
vi.mock("@/components/project/ProjectSettingsDialog", () => ({ ProjectSettingsDialog: () => null }));
vi.mock("@/components/project/ProjectColumnsDialog", () => ({ ProjectColumnsDialog: () => null }));
vi.mock("@/components/project-templates/ProjectTemplateDialog", () => ({ ProjectTemplateDialog: () => null }));
vi.mock("@/components/templates/TemplatesPanel", () => ({ TemplatesPanel: () => null }));
vi.mock("@/components/recurring/RecurringTasksPanel", () => ({ RecurringTasksPanel: () => null }));
vi.mock("@/components/automation/AutomationRulesPanel", () => ({ AutomationRulesPanel: () => null }));
vi.mock("@/components/saved-views/SavedViewsPanel", () => ({ SavedViewsPanel: () => null }));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div> },
}));

import { TelemetryClient } from "@/lib/telemetry/client";
import { ProjectBoardClient } from "./ProjectBoardClient";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const PROOF = `v1.${NOW.getTime() + 3_600_000}.${"a".repeat(64)}`;

const queues: TelemetryClient[] = [];
const clients: QueryClient[] = [];
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  nav.search = "view=board";
  nav.push.mockReset();
  nav.replace.mockReset();
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { kind?: string; sessionId?: string; events?: Array<{ eventId: string }> };
    if (body.kind === "session.start") {
      return Response.json({ success: true, data: { sessionId: body.sessionId, sessionToken: PROOF, expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString() } });
    }
    return Response.json({ success: true, data: { accepted: (body.events ?? []).map(event => event.eventId) } });
  });
});

afterEach(() => {
  cleanup();
  queues.splice(0).forEach(queue => queue.dispose());
  clients.splice(0).forEach(client => client.clear());
  bridge.current = null;
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
  const tree = () => <QueryClientProvider client={client}><ProjectBoardClient projectId="project-1" canManage={false} canCreate /></QueryClientProvider>;
  const view = render(tree());
  await screen.findByText("Board content");
  return { queue, rerender: () => view.rerender(tree()) };
}

describe("simplified project board view telemetry", () => {
  it("hides view switch and options without recording a view intent", async () => {
    const { queue } = await setup();
    for (const name of ["Таблица", "Календарь", "Дополнительно"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    await queue.flush();
    expect(telemetryEvents()).toEqual([]);
    expect(nav.push).not.toHaveBeenCalled();
  });
  it("does not synthesize a view-change intent on direct URL changes or rerenders", async () => {
    const { queue, rerender } = await setup();
    nav.search = "view=calendar";
    rerender(); rerender();
    await queue.flush();
    expect(telemetryEvents()).toEqual([]);
  });
  it("keeps creation working without a telemetry session", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client); bridge.current = null;
    render(<QueryClientProvider client={client}><ProjectBoardClient projectId="project-1" canManage={false} canCreate /></QueryClientProvider>);
    await screen.findByText("Board content");
    fireEvent.click(screen.getByRole("button", { name: "Добавить обращение" }));
    expect(telemetryEvents()).toEqual([]);
    expect(nav.push).toHaveBeenCalledWith("/projects/project-1/board?view=board&create=task", { scroll: false });
  });
});
