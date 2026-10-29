import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import ProjectsPage from "./page";
import AdminProjectsPage from "../admin/projects/page";

vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: "user", globalRole: "USER" } } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const description = "ДлинноеОписаниеБезПробелов".repeat(60);
const project = {
  id: "project-1", name: "Синтетический проект", description,
  createdAt: "2026-10-23T00:00:00Z",
  owner: { id: "owner-1", name: "Owner", email: "owner@example.invalid", globalRole: "USER" },
  _count: { tasks: 12, members: 1 },
};
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string) => url === "/api/projects" ? [project] : { items: [project], nextCursor: null },
}));

afterEach(cleanup);

it.each([ProjectsPage, AdminProjectsPage])("clamps project descriptions inside a shrinkable width", async Page => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  const element = await screen.findByText(description);
  // line-clamp-2 supplies hidden overflow and a two-line ellipsis, including on narrow screens.
  expect(element).toHaveClass("min-w-0", "max-w-full", "line-clamp-2", "[overflow-wrap:anywhere]");
  if (Page === ProjectsPage) {
    expect(element.parentElement).toHaveClass("min-w-0");
    expect(element.closest("a")).toHaveClass("min-w-0");
  } else {
    expect(element.closest("table")).toHaveClass("table-fixed");
  }
});
