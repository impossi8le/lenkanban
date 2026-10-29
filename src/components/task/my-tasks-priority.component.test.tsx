import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.get }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: "priority-actor" } } }) }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: vi.fn() }) }));
// This suite exercises the list; existing command suites exercise the real loader.
vi.mock("@/app/(dashboard)/my-tasks/MyTaskCommandLoader", () => ({ MyTaskCommandLoader: () => null, isMyTaskReadDenied: () => false }));
import MyTasksPage from "@/app/(dashboard)/my-tasks/page";

const priorities = ["LOW", "OTHER", "URGENT", "CRITICAL", "MEDIUM", "HIGH"];
const tasks = priorities.map((priority, index) => ({
  id: `task-${index}`, title: `Задача ${priority}`, priority, status: "TODO",
  project: { id: "project", name: "Проект" }, attachments: [], deadline: null,
  createdAt: `2026-10-${String(20 - index).padStart(2, "0")}T10:00:00Z`,
}));
const clients: QueryClient[] = [];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
beforeEach(() => {
  mocks.get.mockReset(); mocks.get.mockResolvedValue(tasks);
  // jsdom has no scrolling implementation; Radix calls this browser API on open.
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear());
  if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><MyTasksPage /></QueryClientProvider>);
  await screen.findByRole("button", { name: "Открыть задачу «Задача CRITICAL»" });
}
it("maps legacy urgent priorities to the demo urgency marker without rewriting source rows", async () => {
  await mount();
  const criticalCard = screen.getByRole("button", { name: "Открыть задачу «Задача CRITICAL»" }).closest(".request-card")!;
  expect(within(criticalCard as HTMLElement).getByText("СРОЧНО")).toBeVisible();
  expect(screen.getAllByText("СРОЧНО")).toHaveLength(3);
  const unknownCard = screen.getByRole("button", { name: "Открыть задачу «Задача OTHER»" }).closest(".request-card")!;
  expect(within(unknownCard as HTMLElement).queryByText("СРОЧНО")).not.toBeInTheDocument();
  expect(tasks.map(task => task.priority)).toEqual(priorities);
});

it("puts urgent requests first, preserving newest creation within each group", async () => {
  await mount();
  expect(screen.getAllByRole("button", { name: /^Открыть задачу/ }).map(node => node.textContent)).toEqual(["URGENT", "CRITICAL", "HIGH", "LOW", "OTHER", "MEDIUM"].map(value => `Задача ${value}`));
});

it("filters urgent requests using the demo two-way control, including legacy values", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Срочные" }));
  expect(screen.getByRole("button", { name: "Срочные" })).toHaveAttribute("aria-pressed", "true");
  await waitFor(() => expect(screen.getAllByRole("button", { name: /^Открыть задачу/ }).map(node => node.textContent)).toEqual(["URGENT", "CRITICAL", "HIGH"].map(value => `Задача ${value}`)));
  fireEvent.click(within(screen.getByRole("group", { name: "Фильтр срочности" })).getByRole("button", { name: "Все" }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: /^Открыть задачу/ })).toHaveLength(6));
  expect(mocks.get).toHaveBeenCalledWith("/api/tasks?assignedToMe=true&limit=500", expect.objectContaining({ signal: expect.any(AbortSignal) }));
});
