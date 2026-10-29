import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType, ReactNode } from "react";

const nav = vi.hoisted(() => ({ search: "", pathname: "/projects/project-1/board" as string | null, push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, replace: nav.replace }), usePathname: () => nav.pathname, useSearchParams: () => new URLSearchParams(nav.search) }));
// Views and dialogs are split into their own chunks, so a dynamic component
// resolves through React.lazy and appears one microtask after the first open.
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
vi.mock("@/components/views/CalendarView", () => ({ CalendarView: () => <div>Calendar content</div> }));
vi.mock("@/components/task/CreateTaskDialog", () => ({ CreateTaskDialog: ({ open, canCreate, onClose }: { open: boolean; canCreate: boolean; onClose: () => void }) => open ? <div role="dialog" aria-label="Create intent"><span>{canCreate ? "Allowed" : "Denied"}</span><button onClick={onClose}>Close create</button></div> : null }));
vi.mock("@/components/kanban/BoardOptionsMenu", () => ({ BoardOptionsMenu: () => null }));
vi.mock("@/components/project/ProjectMembersDialog", () => ({ ProjectMembersDialog: () => null }));
vi.mock("@/components/project/ProjectSettingsDialog", () => ({ ProjectSettingsDialog: () => null }));
vi.mock("@/components/project/ProjectColumnsDialog", () => ({ ProjectColumnsDialog: () => null }));
vi.mock("@/components/project-templates/ProjectTemplateDialog", () => ({ ProjectTemplateDialog: () => null }));
vi.mock("@/components/templates/TemplatesPanel", () => ({ TemplatesPanel: () => null }));
vi.mock("@/components/recurring/RecurringTasksPanel", () => ({ RecurringTasksPanel: () => null }));
vi.mock("@/components/automation/AutomationRulesPanel", () => ({ AutomationRulesPanel: () => null }));
vi.mock("@/components/saved-views/SavedViewsPanel", () => ({ SavedViewsPanel: () => null }));
vi.mock("motion/react", () => ({ AnimatePresence: ({ children }: { children: ReactNode }) => children, motion: { div: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div> } }));

import { ProjectBoardClient } from "./ProjectBoardClient";

const clients: QueryClient[] = [];
function mount(canCreate = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const tree = () => <QueryClientProvider client={client}><ProjectBoardClient projectId="project-1" canManage={false} canCreate={canCreate} /></QueryClientProvider>;
  const result = render(tree());
  return { navigate: (search: string, pathname: string | null = nav.pathname) => { nav.search = search; nav.pathname = pathname; result.rerender(tree()); } };
}
beforeEach(() => {
  nav.search = "view=table";
  nav.pathname = "/projects/project-1/board";
  nav.push.mockReset(); nav.replace.mockReset();
  localStorage.clear();
  window.history.replaceState(null, "", "/projects/project-1/board");
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

describe("project URL view and create intent", () => {
  it("prefers URL over storage and follows browser history query changes", async () => {
    localStorage.setItem("kanban-view-preference", "calendar");
    const page = mount();
    expect(await screen.findByText("Table content")).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
    page.navigate("view=calendar");
    expect(await screen.findByText("Calendar content")).toBeInTheDocument();
    page.navigate("view=board");
    expect(screen.getByText("Board content")).toBeInTheDocument();
    page.navigate("view=table");
    expect(await screen.findByText("Table content")).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it.each(["/projects/project-1/tasks/task-1", "/projects/other-project/board", null])("does not canonicalize the retained board on pathname %s without a view query", pathname => {
    const history = vi.spyOn(window.history, "replaceState");
    nav.search = "view=board";
    const page = mount();
    expect(nav.replace).not.toHaveBeenCalled();
    // Parallel-route background stays mounted as task navigation clears search.
    page.navigate("", pathname);
    expect(screen.getByText("Board content")).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  it("makes the default view explicit without another server navigation or history entry", () => {
    nav.search = "keep=yes";
    window.history.replaceState(null, "", "/projects/project-1/board?keep=yes#request-list");
    const history = vi.spyOn(window.history, "replaceState");
    const historyLength = window.history.length;
    mount();
    expect(screen.getByText("Board content")).toBeInTheDocument();
    expect(history).toHaveBeenCalledExactlyOnceWith(null, "", "/projects/project-1/board?keep=yes&view=board#request-list");
    expect(window.history.length).toBe(historyLength);
    expect(nav.replace).not.toHaveBeenCalled(); expect(nav.push).not.toHaveBeenCalled();
  });

  it("keeps legacy task intent as a real task navigation instead of rewriting it as a view", () => {
    nav.search = "task=task-1&keep=yes";
    const history = vi.spyOn(window.history, "replaceState");
    mount();
    expect(history).not.toHaveBeenCalled();
    expect(nav.replace).toHaveBeenCalledExactlyOnceWith("/projects/project-1/tasks/task-1");
  });

  it.each(["", "view=invalid"])("defaults %s to the approved board despite an old preference and preserves create", async query => {
    localStorage.setItem("kanban-view-preference", "calendar");
    nav.search = `${query}&create=task&keep=yes`;
    const history = vi.spyOn(window.history, "replaceState");
    mount();
    await waitFor(() => expect(history).toHaveBeenCalledTimes(1));
    const href = new URL(String(history.mock.calls[0][2]), "http://localhost");
    expect(href.searchParams.get("view")).toBe("board");
    expect(href.searchParams.get("create")).toBe("task");
    expect(href.searchParams.get("keep")).toBe("yes");
    expect(await screen.findByRole("dialog", { name: "Create intent" })).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled(); expect(nav.push).not.toHaveBeenCalled();
  });

  it("hides view switches and opens creation while preserving unrelated params", () => {
    nav.search = "view=table&keep=yes";
    mount();
    expect(screen.queryByRole("button", { name: "Календарь" })).not.toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Добавить обращение" }));
    expect(nav.push).toHaveBeenLastCalledWith("/projects/project-1/board?view=table&keep=yes&create=task", { scroll: false });
    expect(screen.getByRole("button", { name: "Добавить обращение" })).toHaveAttribute("data-create-task");
  });

  it("opens creation after reload and closes by replacing only its intent", async () => {
    nav.search = "view=calendar&create=task&keep=yes";
    const page = mount();
    expect(await screen.findByRole("dialog", { name: "Create intent" })).toHaveTextContent("Allowed");
    fireEvent.click(screen.getByRole("button", { name: "Close create" }));
    expect(nav.replace).toHaveBeenCalledWith("/projects/project-1/board?view=calendar&keep=yes", { scroll: false });
    page.navigate("view=calendar&keep=yes");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("has no creation trigger without permission and handles direct intent as denied", async () => {
    nav.search = "view=board&create=task";
    mount(false);
    expect(screen.queryByRole("button", { name: "Добавить обращение" })).not.toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "Create intent" })).toHaveTextContent("Denied");
  });

  it("keeps URL navigation working when preference storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    nav.search = "keep=yes";
    const history = vi.spyOn(window.history, "replaceState");
    mount();
    expect(screen.getByText("Board content")).toBeInTheDocument();
    expect(history).toHaveBeenCalledWith(null, "", "/projects/project-1/board?keep=yes&view=board");
    expect(nav.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Таблица" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Добавить обращение" }));
    expect(nav.push).toHaveBeenCalledWith("/projects/project-1/board?keep=yes&view=board&create=task", { scroll: false });
  });
});
