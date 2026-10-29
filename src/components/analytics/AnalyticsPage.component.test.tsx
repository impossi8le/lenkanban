import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const { analyticsFixture } = vi.hoisted(() => ({
  analyticsFixture: {
    tasksByStatus: [
      { status: "TODO", count: 3 },
      { status: "IN_PROGRESS", count: 2 },
      { status: "IN_REVIEW", count: 1 },
      { status: "DONE", count: 4 },
    ],
    tasksByPriority: [{ priority: "HIGH", count: 2 }],
    velocity: [{ week: "W1", completed: 2, date: "2026-09-01" }],
    burndown: [{ date: "2026-09-01", remaining: 5, ideal: 6 }],
    assigneeWorkload: [{ userId: "synthetic-user", taskCount: 3, user: { name: "Синтетический исполнитель", email: "worker@example.invalid" } }],
    summary: { totalTasks: 10, completedThisMonth: 4, overdueTasks: 1 },
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: analyticsFixture, isLoading: false }),
}));

vi.mock("@/lib/export-utils", () => ({ exportAnalyticsToPDF: vi.fn() }));

// Recharts needs a measured container, which jsdom cannot provide. These stubs
// keep the chart props observable: Pie renders its `label` only when the chart
// still uses outside labels, and Legend renders the payload it is given.
vi.mock("recharts", () => {
  const PassThrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: PassThrough,
    PieChart: PassThrough,
    BarChart: PassThrough,
    LineChart: PassThrough,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Cell: () => null,
    Bar: () => null,
    Line: () => null,
    Pie: ({
      data = [],
      label,
    }: {
      data?: Array<{ label: string; count: number }>;
      label?: (entry: Record<string, unknown>) => string;
    }) => (
      <div data-testid="status-pie">
        {typeof label === "function"
          ? data.map((entry, index) => (
              <span key={index}>{label({ ...entry, percent: 0.25 })}</span>
            ))
          : null}
      </div>
    ),
    Legend: ({ payload = [] }: { payload?: Array<{ value?: string }> }) => (
      <ul data-testid="status-legend">
        {payload.map((entry, index) => (
          <li key={index}>{entry.value}</li>
        ))}
      </ul>
    ),
  };
});

import { AnalyticsPage } from "./AnalyticsPage";

afterEach(cleanup);

it("titles the velocity and burndown charts in Russian", () => {
  render(<AnalyticsPage />);

  expect(screen.getByText("Скорость")).toBeInTheDocument();
  expect(screen.getByText("Диаграмма сгорания задач")).toBeInTheDocument();
  expect(screen.queryByText("Velocity")).not.toBeInTheDocument();
  expect(screen.queryByText("Burndown Chart")).not.toBeInTheDocument();
});

it("shows status names and counts in a legend instead of overlapping slice labels", () => {
  render(<AnalyticsPage />);

  const legend = screen.getByTestId("status-legend");
  expect(legend).toHaveTextContent("К выполнению: 3");
  expect(legend).toHaveTextContent("В работе: 2");
  expect(legend).toHaveTextContent("На проверке: 1");
  expect(legend).toHaveTextContent("Готово: 4");
  expect(screen.getByTestId("status-pie")).toBeEmptyDOMElement();
  expect(screen.queryByText(/TODO|IN_PROGRESS|IN_REVIEW/)).not.toBeInTheDocument();
});

it("exposes every chart's values as a named semantic table and hides duplicate visual SVG content", () => {
  render(<AnalyticsPage />);
  expect(screen.getAllByRole("table")).toHaveLength(5);
  const status = screen.getByRole("table", { name: "Задачи по статусам: данные" });
  expect(screen.getByRole("figure", { name: "Задачи по статусам" })).toContainElement(status);
  expect(within(status).getByRole("columnheader", { name: "Статус" })).toHaveAttribute("scope", "col");
  expect(within(status).getByRole("row", { name: "К выполнению 3" })).toBeInTheDocument();
  expect(within(screen.getByRole("table", { name: "Задачи по приоритетам: данные" })).getByRole("row", { name: "Высокий 2" })).toBeInTheDocument();
  expect(within(screen.getByRole("table", { name: "Скорость: данные" })).getByRole("row", { name: "W1 2" })).toBeInTheDocument();
  expect(within(screen.getByRole("table", { name: "Диаграмма сгорания задач: данные" })).getByRole("row", { name: "2026-09-01 5 6" })).toBeInTheDocument();
  expect(within(screen.getByRole("table", { name: "Нагрузка исполнителей: данные" })).getByRole("row", { name: "Синтетический исполнитель 3" })).toBeInTheDocument();
  expect(screen.getByTestId("status-pie").closest('[aria-hidden="true"]')).toBeInTheDocument();
});
