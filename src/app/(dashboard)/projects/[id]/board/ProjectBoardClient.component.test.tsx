import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
  apiFetch: vi.fn(),
  apiPost: vi.fn(),
  socketOn: vi.fn(),
  socketOff: vi.fn(),
}));
const storage = new Map<string, string>();

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/project-1/board",
  useRouter: () => ({
    push: mocks.push,
    replace: mocks.replace,
  }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
// Views are split into their own chunks, so a dynamic view resolves through
// React.lazy here instead of rendering synchronously.
vi.mock("next/dynamic", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    default: (loader: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>) => {
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
vi.mock("@/lib/api", () => ({
  apiFetch: mocks.apiFetch,
  apiPost: mocks.apiPost,
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock("@/lib/socket-client", () => ({
  getSocketInstance: () => ({
    on: mocks.socketOn,
    off: mocks.socketOff,
  }),
}));
vi.mock("@/components/kanban/Board", () => ({
  KanbanBoard: ({ manualTaskMovesEnabled }: { manualTaskMovesEnabled: boolean }) => <output aria-label="Manual task moves">{String(manualTaskMovesEnabled)}</output>,
}));
vi.mock("@/components/views/TableView", () => ({
  TableView: ({
    onTaskClick,
    search,
    onSearchChange,
    sortBy,
    onSortByChange,
  }: {
    onTaskClick?: (task: { id: string }) => void;
    search?: string;
    onSearchChange?: (value: string) => void;
    sortBy?: string;
    onSortByChange?: (value: string) => void;
  }) => (
    <>
      <input
        aria-label="Поиск таблицы"
        value={search ?? ""}
        onChange={(event) => onSearchChange?.(event.target.value)}
      />
      <select
        aria-label="Сортировка таблицы"
        value={sortBy ?? "position"}
        onChange={(event) => onSortByChange?.(event.target.value)}
      >
        <option value="position">По позиции</option>
        <option value="title-desc">По названию убывание</option>
      </select>
      <button
        type="button"
        onClick={() => onTaskClick?.({ id: "task-42" })}
      >
        Открыть задачу из таблицы
      </button>
    </>
  ),
}));
vi.mock("@/components/views/CalendarView", () => ({
  CalendarView: ({
    onTaskClick,
  }: {
    onTaskClick?: (task: { id: string }) => void;
  }) => (
    <button
      type="button"
      onClick={() => onTaskClick?.({ id: "task-84" })}
    >
      Открыть задачу из календаря
    </button>
  ),
}));
vi.mock("@/components/views/ViewSwitcher", () => ({
  ViewSwitcher: () => null,
}));
vi.mock("@/components/kanban/BoardOptionsMenu", () => ({
  BoardOptionsMenu: ({ onSavedViews }: { onSavedViews: () => void }) => (
    <button onClick={onSavedViews}>Представления</button>
  ),
}));
vi.mock("@/components/project/ProjectMembersDialog", () => ({
  ProjectMembersDialog: () => null,
}));
vi.mock("@/components/project/ProjectSettingsDialog", () => ({
  ProjectSettingsDialog: () => null,
}));
vi.mock("@/components/project/ProjectColumnsDialog", () => ({
  ProjectColumnsDialog: () => null,
}));
vi.mock("@/components/project-templates/ProjectTemplateDialog", () => ({
  ProjectTemplateDialog: () => null,
}));
vi.mock("@/components/templates/TemplatesPanel", () => ({
  TemplatesPanel: () => null,
}));
vi.mock("@/components/recurring/RecurringTasksPanel", () => ({
  RecurringTasksPanel: () => null,
}));
vi.mock("@/components/automation/AutomationRulesPanel", () => ({
  AutomationRulesPanel: () => null,
}));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) =>
    children,
  motion: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ProjectBoardClient } from "./ProjectBoardClient";

afterEach(cleanup);

beforeEach(() => {
  mocks.search = "";
  mocks.push.mockReset();
  mocks.replace.mockReset();
  mocks.apiPost.mockReset();
  mocks.apiFetch.mockReset().mockResolvedValue({
    id: "project-1",
    name: "Project",
    description: null,
    ownerId: "user-1",
    boardRevision: 0,
    dndV2Enabled: true,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  });
  storage.clear();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size;
      },
    },
  });
  localStorage.setItem("kanban-view-preference", "table");
});

describe("ProjectBoardClient page heading", () => {
  it("starts the page with the project name as its only level-one heading", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ProjectBoardClient projectId="project-1" canManage={false} />
      </QueryClientProvider>,
    );

    const heading = await screen.findByRole("heading", { name: "Project" });
    expect(heading.tagName).toBe("H1");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("ProjectBoardClient table navigation", () => {
  it("keeps direct table use but hides saved-view options for all users", async () => {
    mocks.search = "view=table";
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><ProjectBoardClient projectId="project-1" canManage={false} /></QueryClientProvider>);
    await user.type(await screen.findByRole("textbox", { name: "Поиск таблицы" }), "Насос");
    await user.selectOptions(screen.getByRole("combobox", { name: "Сортировка таблицы" }), "title-desc");
    expect(screen.getByRole("textbox", { name: "Поиск таблицы" })).toHaveValue("Насос");
    expect(screen.getByRole("combobox", { name: "Сортировка таблицы" })).toHaveValue("title-desc");
    expect(screen.queryByRole("button", { name: "Представления" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Дополнительно" })).not.toBeInTheDocument();
    expect(mocks.apiPost).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("opens the same intercepted task route from a table row", async () => {
    mocks.search = "view=table";
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ProjectBoardClient projectId="project-1" canManage={false} />
      </QueryClientProvider>,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Открыть задачу из таблицы",
      }),
    );

    expect(mocks.push).toHaveBeenCalledWith(
      "/projects/project-1/tasks/task-42",
    );
  });

  it("opens the same intercepted task route from a calendar item", async () => {
    mocks.search = "view=calendar";
    localStorage.setItem("kanban-view-preference", "calendar");
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ProjectBoardClient projectId="project-1" canManage={false} />
      </QueryClientProvider>,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Открыть задачу из календаря",
      }),
    );

    expect(mocks.push).toHaveBeenCalledWith(
      "/projects/project-1/tasks/task-84",
    );
  });
});

describe("lifecycle board manual move policy", () => {
  it.each([null, { contractVersion: 1 }, {}])("keeps manual task moves disabled across boards (map=%j)", async lifecycleColumnMap => {
    localStorage.setItem("kanban-view-preference", "board");
    mocks.apiFetch.mockResolvedValue({ id: "project-1", name: "Project", dndV2Enabled: true, lifecycleColumnMap });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ProjectBoardClient projectId="project-1" canManage canChangeStatus /></QueryClientProvider>);
    await screen.findByRole("heading", { name: "Project" });
    expect(screen.getByLabelText("Manual task moves")).toHaveTextContent("false");
    client.clear();
  });
  it("does not expose moves before project metadata arrives", () => {
    localStorage.setItem("kanban-view-preference", "board");
    mocks.apiFetch.mockReturnValue(new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ProjectBoardClient projectId="project-1" canManage canChangeStatus /></QueryClientProvider>);
    expect(screen.getByLabelText("Manual task moves")).toHaveTextContent("false");
    client.clear();
  });
});
