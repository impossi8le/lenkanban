import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import AdminUsersPage from "./page";

vi.mock("@/lib/api", () => ({
  apiFetch: async () => ({ items: [1, 2].map(id => ({
    id: `user-${id}`, name: `User ${id}`, email: `user-${id}@example.invalid`,
    globalRole: "USER", createdAt: "2026-10-23T00:00:00Z",
    _count: { projects: 0, projectMemberships: 0, apiTokens: 0 },
  })), nextCursor: null }),
}));

afterEach(cleanup);

it("keeps every role link at least 44 by 44 CSS px in the existing keyboard order", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminUsersPage /></QueryClientProvider>);
  const links = await screen.findAllByRole("link", { name: "Изменить роль" });
  expect(links).toHaveLength(2);
  for (const link of links) {
    // Tailwind 11 spacing units = 44 CSS px with the project's default scale.
    expect(link).toHaveClass("inline-flex", "min-h-11", "min-w-11");
    expect(link).not.toHaveAttribute("tabindex");
  }
  links[0].focus();
  await userEvent.tab();
  expect(links[1]).toHaveFocus();
});
