import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkActionsBar } from "./BulkActionsBar";
import { BulkActionsToolbar } from "@/components/views/BulkActionsToolbar";
import { TableView } from "@/components/views/TableView";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: mocks.apiFetch,
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock("@/components/ui/select", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const SelectContext = React.createContext<
    ((value: string) => void) | undefined
  >(undefined);
  return {
    Select: ({
      children,
      onValueChange,
    }: {
      children: React.ReactNode;
      onValueChange?: (value: string) => void;
    }) => (
      <SelectContext.Provider value={onValueChange}>
        {children}
      </SelectContext.Provider>
    ),
    SelectTrigger: ({
      children,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button
        type="button"
        role="combobox"
        aria-controls="test-select-options"
        aria-expanded="false"
        {...props}
      >
        {children}
      </button>
    ),
    SelectValue: ({ placeholder }: { placeholder?: string }) => (
      <span>{placeholder}</span>
    ),
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      children,
      value,
    }: {
      children: React.ReactNode;
      value: string;
    }) => {
      const onValueChange = React.useContext(SelectContext);
      return (
        <button
          type="button"
          role="option"
          aria-selected="false"
          onClick={() => onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
  };
});

afterEach(cleanup);

const workflowColumns = [
  {
    id: "column-triage",
    name: "Триаж",
  },
  {
    id: "column-delivery",
    name: "Доставка",
  },
];

function renderWithQueryClient(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {node}
    </QueryClientProvider>,
  );
}

describe("bulk workflow actions", () => {
  it("offers project workflow columns in the table bulk toolbar", async () => {
    renderWithQueryClient(
      <BulkActionsToolbar
        selectedTasks={[
          {
            id: "task-1",
            title: "Task",
            columnId: "column-triage",
            priority: "MEDIUM",
            position: 1024,
            projectId: "project-1",
          },
        ]}
        projectId="project-1"
        columns={workflowColumns}
        onClearSelection={vi.fn()}
      />,
    );

    expect(screen.getByRole("option", { name: "Доставка" })).toBeVisible();
  });

  it("offers project workflow columns in the board bulk bar", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <BulkActionsBar
        selectedTaskIds={["task-1"]}
        projectId="project-1"
        columns={workflowColumns}
        onClearSelection={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("option", { name: "Переместить" }));

    expect(screen.getByRole("option", { name: "Доставка" })).toBeVisible();
  });

  it("renders a dynamic workflow column name instead of its raw compatibility status", async () => {
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/tasks?")) {
        return Promise.resolve([
          {
            id: "task-1",
            title: "Dynamic task",
            status: "COLUMN_column-delivery",
            columnId: "column-delivery",
            column: {
              id: "column-delivery",
              name: "Доставка",
              color: "#3B82F6",
            },
            priority: "MEDIUM",
            position: 1024,
            projectId: "project-1",
            assignees: [],
            tags: [],
          },
        ]);
      }
      if (url.includes("/columns")) {
        return Promise.resolve(workflowColumns);
      }
      return Promise.resolve([]);
    });

    renderWithQueryClient(
      <TableView projectId="project-1" onTaskClick={vi.fn()} />,
    );

    expect(
      await screen.findByRole("cell", { name: "Доставка" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("COLUMN_column-delivery")).toBeNull();
  });
});
