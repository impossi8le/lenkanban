import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { MobileSidebar } from "./mobile-sidebar";

vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "actor" } }, status: "authenticated" }) }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => "/inbox" }));
vi.mock("@/hooks/useUnreadCounts", () => ({
  useUnreadCounts: () => ({ byProject: {}, total: 0 }),
}));

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
});

function mountAdmin() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/admin/me") {
        return Response.json({
          success: true,
          data: { id: "a1", email: "admin@example.test", name: "Admin", globalRole: "ADMIN" },
        });
      }
      if (url === "/api/projects") {
        return Response.json({ success: true, data: [] });
      }
      return Response.json({ success: true, data: null });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MobileSidebar />
    </QueryClientProvider>,
  );
}

it("shows /admin/users and /admin/projects for an admin user", async () => {
  mountAdmin();
  fireEvent.click(screen.getByRole("button", { name: "Переключить меню" }));
  await waitFor(() => screen.getByRole("link", { name: "Пользователи" }));
  expect(screen.getByRole("link", { name: "Пользователи" })).toHaveAttribute("href", "/admin/users");
  const adminProjects = screen
    .getAllByRole("link", { name: "Проекты" })
    .find((el) => el.getAttribute("href") === "/admin/projects");
  expect(adminProjects).toBeInTheDocument();
});

it("shows distinct organization admin links for an admin user", async () => {
  mountAdmin();
  fireEvent.click(screen.getByRole("button", { name: "Переключить меню" }));
  await waitFor(() => screen.getByRole("link", { name: "Подразделения" }));
  expect(screen.getByRole("link", { name: "Группы" })).toHaveAttribute("href", "/admin/organization/groups");
  expect(screen.getByRole("link", { name: "Назначения" })).toHaveAttribute("href", "/admin/organization/assignments");
  expect(screen.getByRole("link", { name: "Привязки досок" })).toHaveAttribute("href", "/admin/organization/bindings");
  expect(screen.getByRole("link", { name: "Круг заявителей" })).toHaveAttribute("href", "/admin/organization/applicants");
  expect(screen.getByRole("link", { name: "Профили прав" })).toHaveAttribute("href", "/admin/organization/privileges");
});
