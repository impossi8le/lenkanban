import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { Sidebar } from "./sidebar";
import userEvent from "@testing-library/user-event";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "actor", name: "Admin", email: "admin@example.test" } },
    status: "authenticated",
  }),
}));
vi.mock("@/hooks/useUnreadCounts", () => ({
  useUnreadCounts: () => ({ byProject: {}, total: 0 }),
}));

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), pathname: "/projects" }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => mocks.pathname }));

afterEach(() => {
  cleanup();
  mocks.apiFetch.mockReset();
  mocks.pathname = "/projects";
});

function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Sidebar />
    </QueryClientProvider>,
  );
}

it.each(["/projects", "/projects/project-1/board"])("gives every sidebar link a themed visible focus ring under Tab on %s", async pathname => {
  mocks.pathname = pathname;
  mocks.apiFetch.mockImplementation(async (url: string) => url === "/api/admin/me"
    ? { globalRole: "ADMIN" }
    : [{ id: "project-1", name: "Синтетическая доска", color: null, emoji: null }]);
  renderSidebar();
  await screen.findByRole("link", { name: "Техподдержка и ИТ" });
  await userEvent.click(await screen.findByRole("button", { name: "Организация" }));
  const links = screen.getAllByRole("link");
  for (const link of links) {
    expect(link).toHaveClass("focus-visible:ring-2", "focus-visible:ring-ring");
  }
  links[0].focus();
  expect(links[0]).toHaveFocus();
  // Walk the actual tab sequence, including the organization toggle between links.
  for (const link of links.slice(1)) {
    await userEvent.tab();
    if (document.activeElement === screen.getByRole("button", { name: "Организация" })) await userEvent.tab();
    expect(link).toHaveFocus();
  }
});

it("renders /admin/users and /admin/projects in the admin section", async () => {
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === "/api/admin/me") return { globalRole: "ADMIN" };
    if (url === "/api/projects") return [];
    return null;
  });

  renderSidebar();

  expect(await screen.findByRole("link", { name: "Пользователи" })).toHaveAttribute("href", "/admin/users");
  const adminProjects = screen.getAllByRole("link", { name: "Проекты" })
    .find((el) => el.getAttribute("href") === "/admin/projects");
  expect(adminProjects).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Добавить направление" })).toBeInTheDocument();
});

it("groups organization admin links under Организация", async () => {
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === "/api/admin/me") return { globalRole: "ADMIN" };
    if (url === "/api/projects") return [];
    return null;
  });

  renderSidebar();

  const orgButton = await screen.findByRole("button", { name: "Организация" });
  fireEvent.click(orgButton);
  await waitFor(() => {
    expect(screen.getByRole("link", { name: "Подразделения" })).toHaveAttribute("href", "/admin/organization");
    expect(screen.getByRole("link", { name: "Группы" })).toHaveAttribute("href", "/admin/organization/groups");
  });
});

it("hides analytics, management, board creation and settings for an ordinary user", async () => {
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === "/api/admin/me") return { globalRole: "USER" };
    if (url === "/api/projects") return [];
    return null;
  });

  renderSidebar();

  expect(await screen.findByRole("navigation", { name: "Основная навигация" })).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Запросы в отделы" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Аналитика" })).not.toBeInTheDocument();
  expect(screen.queryByText("Управление")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Добавить направление" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Настройки" })).not.toBeInTheDocument();
});

it("keeps expanded organization navigation keyboard reachable with visible focus and a separate footer", async () => {
  mocks.apiFetch.mockImplementation(async (url: string) => url === "/api/admin/me" ? { globalRole: "ADMIN" } : [{ id: "project-1", name: "Синтетическая доска" }]);
  renderSidebar();
  const org = await screen.findByRole("button", { name: "Организация" });
  org.focus();
  await userEvent.keyboard("{Enter}");
  expect(org).toHaveAttribute("aria-expanded", "true");
  await userEvent.tab();
  expect(screen.getByRole("link", { name: "Подразделения" })).toHaveFocus();
  for (const link of screen.getAllByRole("link").filter(link => link.getAttribute("aria-label") !== "Добавить направление")) {
    expect(link).toHaveClass("focus-visible:ring-2", "focus-visible:ring-inset");
  }
  expect(org).toHaveClass("min-h-11", "focus-visible:ring-2");
  const footer = screen.getByRole("contentinfo", { name: "Настройки и профиль" });
  expect(footer).toHaveClass("shrink-0");
  expect(screen.getByRole("navigation", { name: "Основная навигация" }).parentElement).not.toContainElement(footer);
  const settings = screen.getByRole("link", { name: "Настройки" });
  expect(footer).toContainElement(settings);
  expect(settings).toHaveAttribute("href", "/settings");
  expect(footer).toContainElement(screen.getByRole("button", { name: "Выбрать тему" }));
  settings.focus();
  expect(settings).toHaveFocus();
  await userEvent.tab();
  expect(screen.getByRole("button", { name: "Выбрать тему" })).toHaveFocus();
  const scroll = screen.getByRole("navigation", { name: "Основная навигация" }).parentElement!;
  expect(scroll).toHaveClass("min-h-0", "flex-1", "overflow-y-auto", "overflow-x-hidden");
  expect(footer.parentElement).toHaveClass("overflow-hidden", "min-h-0", "h-full");
});

it("keeps the demo personal scopes and global request entry accessible when collapsed", async () => {
  mocks.apiFetch.mockImplementation(async (url: string) => url === "/api/admin/me" ? { globalRole: "USER" } : [{ id: "it", name: "Техподдержка и ИТ", color: null, emoji: null }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Sidebar isCollapsed /></QueryClientProvider>);
  expect(screen.getByRole("button", { name: "Добавить обращение" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Мой день" })).toHaveAttribute("href", "/my-day");
  for (const [label, scope] of [["Мои отправленные обращения", "mine"], ["Я исполнитель", "assigned"], ["Мне нужно ответить", "reply"]]) expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", `/my-tasks?scope=${scope}`);
  expect(await screen.findByRole("link", { name: "Техподдержка и ИТ" })).toHaveAttribute("href", "/departments/support");
  for (const name of ["Сообщения", "Входящие", "Уведомления", "Аналитика"]) expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
});
