import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";
import type { View } from "react-big-calendar";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch }));

type TestEvent = { task: TaskType };
type CalendarProps = {
  date: Date;
  view: View;
  onNavigate: (date: Date) => void;
  onView: (view: View) => void;
  onSelectEvent: (event: TestEvent) => void;
  events: TestEvent[];
  components: { event: React.ComponentType<{ event: TestEvent }> };
};

vi.mock("react-big-calendar", () => ({
  dateFnsLocalizer: () => ({}),
  Calendar: ({ events }: CalendarProps) => (
    <div>
      <span data-testid="event-count">{events.length}</span>
      {events.map((event) => (
        <div key={event.task.id}>{event.task.title}</div>
      ))}
    </div>
  ),
}));

import { CalendarView } from "./CalendarView";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
  mocks.apiFetch.mockReset();
});

function show(tasks: TaskType[], props: Partial<React.ComponentProps<typeof CalendarView>> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(["tasks", "project-1"], tasks);
  client.setQueryData(["columns", "project-1"], [
    { id: "todo", name: "К выполнению" },
    { id: "done", name: "Готово" },
  ]);
  client.setQueryData(["project-members", "project-1"], []);
  client.setQueryData(["tags", "project-1"], [
    { id: "t1", name: "Баг", color: "#ef4444" },
    { id: "t2", name: "Фича", color: "#22c55e" },
  ]);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  render(
    <QueryClientProvider client={client}>
      <CalendarView projectId="project-1" onTaskClick={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
}

function task(id: string, title: string, overrides: Partial<TaskType> = {}): TaskType {
  return {
    id,
    title,
    projectId: "project-1",
    priority: "MEDIUM",
    position: 0,
    deadline: new Date("2026-11-03T12:00:00Z"),
    columnId: "todo",
    assignees: [],
    tags: [],
    ...overrides,
  };
}

it("applies the shared filters to calendar events", () => {
  const tasks = [
    task("a", "High bug", { priority: "HIGH", tags: [{ id: "x", tag: { id: "t1", name: "Баг", color: "#ef4444" } }] }),
    task("b", "Low bug", { priority: "LOW", tags: [{ id: "y", tag: { id: "t1", name: "Баг", color: "#ef4444" } }] }),
    task("c", "High feature", { priority: "HIGH", tags: [{ id: "z", tag: { id: "t2", name: "Фича", color: "#22c55e" } }] }),
  ];
  show(tasks, { priorityFilter: "HIGH", tagsFilter: ["t1"] });
  expect(screen.getByTestId("event-count")).toHaveTextContent("1");
  expect(screen.getByText("High bug")).toBeInTheDocument();
});

it("filters by status and assignee including unassigned", () => {
  const tasks = [
    task("a", "Todo unassigned", { columnId: "todo", assignees: [] }),
    task("b", "Done assigned", {
      columnId: "done",
      assignees: [{ id: "m1", user: { id: "u1", name: "Анна", email: "a@t" } }],
    }),
    task("c", "Todo assigned", {
      columnId: "todo",
      assignees: [{ id: "m2", user: { id: "u2", name: "Борис", email: "b@t" } }],
    }),
  ];
  show(tasks, { statusFilter: "todo", assigneeFilter: "unassigned" });
  expect(screen.getByTestId("event-count")).toHaveTextContent("1");
  expect(screen.getByText("Todo unassigned")).toBeInTheDocument();
});
