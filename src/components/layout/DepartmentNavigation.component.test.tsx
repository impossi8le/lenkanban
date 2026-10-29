import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: "one", status: "authenticated", fetch: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: mocks.actor } }, status: mocks.status }) }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("@/hooks/useNotificationSummary", () => ({ useNotificationSummary: () => ({ byProject: { "local-it": 4 } }) }));
import { DepartmentNavigation } from "./DepartmentNavigation";
let client: QueryClient;
beforeEach(() => { mocks.actor = "one"; mocks.status = "authenticated"; mocks.fetch.mockReset(); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(() => { cleanup(); client.clear(); });
function nav(collapsed = false) { return <QueryClientProvider client={client}><DepartmentNavigation pathname="/projects/local-it/board" isCollapsed={collapsed} /></QueryClientProvider>; }
it("shows exactly three keyboard-accessible destinations while mapping remains pending", () => {
  mocks.fetch.mockImplementation(() => new Promise(() => {}));
  render(nav());
  expect(screen.getAllByRole("link")).toHaveLength(3);
  const support = screen.getByRole("link", { name: "Техподдержка и ИТ" });
  expect(support).toHaveAttribute("href", "/departments/support");
  expect(support).toHaveClass("focus-visible:ring-2");
  support.focus(); expect(support).toHaveFocus();
  expect(screen.getByRole("link", { name: "Претензии клиентов" })).toHaveAttribute("href", "/departments/claim");
  expect(screen.queryByText("Загрузка отделов…")).not.toBeInTheDocument();
  expect(screen.queryByText("4")).not.toBeInTheDocument();
});
it("keeps authorized active state and unread counts without leaking bindings on account switch", async () => {
  mocks.fetch.mockResolvedValue([{ id: "local-it", name: "Техподдержка и ИТ" }]);
  const view = render(nav());
  await waitFor(() => expect(screen.getByRole("link", { name: /Техподдержка/ })).toHaveAttribute("aria-current", "page"));
  expect(screen.getByText("4")).toBeInTheDocument();
  expect(mocks.fetch).toHaveBeenCalledWith("/api/projects?view=navigation", { signal: expect.any(AbortSignal) });
  mocks.fetch.mockImplementation(() => new Promise(() => {})); mocks.actor = "two";
  view.rerender(nav());
  expect(screen.queryByText("4")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Техподдержка и ИТ" })).not.toHaveAttribute("aria-current");
});
it("shares one lightweight request between desktop and mobile navigation", async () => {
  mocks.fetch.mockImplementation(() => new Promise(() => {}));
  render(<QueryClientProvider client={client}><DepartmentNavigation pathname="/" /><DepartmentNavigation pathname="/" isCollapsed /></QueryClientProvider>);
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  expect(mocks.fetch.mock.calls[0][0]).toBe("/api/projects?view=navigation");
});
it("renders collapsed public labels before authentication without fetching protected mappings", () => {
  mocks.status = "loading";
  client.setQueryData(["projects", "navigation", "one"], [{ id: "local-it", name: "Техподдержка и ИТ" }]);
  render(nav(true));
  expect(screen.getByRole("link", { name: "Техподдержка и ИТ" })).toHaveAttribute("title", "Техподдержка и ИТ");
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(screen.queryByText("4")).not.toBeInTheDocument();
});
