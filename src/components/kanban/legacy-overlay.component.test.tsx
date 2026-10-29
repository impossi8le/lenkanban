import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { KanbanBoard } from "./Board";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));
vi.mock("@/hooks/useProjectBoard", () => ({ useProjectBoard: () => ({ socket: null, isJoined: false }) }));
vi.mock("./FilterBar", () => ({ FilterBar: () => null }));
vi.mock("@/components/bulk/BulkActionsBar", () => ({ BulkActionsBar: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keyboard gestures on the open button do not start a drag or create an overlay", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({ success: true, data:
    url.startsWith("/api/tasks?") ? [{ id: "task", title: "Active task", projectId: "project", columnId: "column", position: 1024, priority: "MEDIUM", version: 0 }]
      : url.endsWith("/columns") ? [{ id: "column", name: "Column", position: 0, workflowKey: "TODO", color: "#777777" }]
        : [],
  })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(<QueryClientProvider client={client}><KanbanBoard projectId="project" dndV2Enabled={false} /></QueryClientProvider>);
  const open = await screen.findByRole("button", { name: "Открыть обращение «Active task»" });
  expect(container.querySelector('[data-kanban-drag-handle]')).toBeNull();
  expect(container.querySelector('[aria-roledescription="sortable"]')).toBeNull();
  open.focus();
  fireEvent.keyDown(open, { code: "Space", key: " " });
  fireEvent.keyDown(open, { code: "ArrowRight", key: "ArrowRight" });
  fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
  expect(open).not.toHaveAttribute("aria-pressed");
  expect(container.querySelector('[aria-roledescription="sortable"]')).toBeNull();
  expect(screen.getAllByText("Active task")).toHaveLength(1);
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
});
