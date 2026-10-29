import { cloneElement, type ReactElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ isLoading: false, data: {
  tasksByStatus: [{ status: "TODO", count: 3 }, { status: "DONE", count: 4 }],
  tasksByPriority: [], velocity: [], burndown: [], assigneeWorkload: [],
  summary: { totalTasks: 7, completedThisMonth: 4, overdueTasks: 0 },
} }) }));
vi.mock("@/lib/export-utils", () => ({ exportAnalyticsToPDF: vi.fn() }));
// Only container measurement is replaced; real Recharts renders the SVG sectors.
vi.mock("recharts", async importOriginal => ({
  ...await importOriginal<typeof import("recharts")>(),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width: number; height: number }> }) => cloneElement(children, { width: 500, height: 300 }),
}));
import { AnalyticsPage } from "./AnalyticsPage";

afterEach(cleanup);

it("labels real SVG sectors and exposes the same values in an accessible chart alternative", async () => {
  render(<AnalyticsPage />);
  const chart = screen.getByRole("figure", { name: "Задачи по статусам" });
  const table = within(chart).getByRole("table", { name: "Задачи по статусам: данные" });
  for (const row of ["К выполнению 3", "Готово 4"]) {
    expect(within(table).getByRole("row", { name: row })).toBeInTheDocument();
  }
  await waitFor(() => expect(chart.querySelectorAll("path.recharts-sector[role=img]")).toHaveLength(2), { timeout: 3000 });
  expect(Array.from(chart.querySelectorAll("path.recharts-sector[role=img]"), sector => sector.getAttribute("aria-label")))
    .toEqual(["К выполнению: 3", "Готово: 4"]);
  expect(chart.querySelector('[aria-hidden="true"] button, [aria-hidden="true"] [tabindex="0"]')).toBeNull();
});
