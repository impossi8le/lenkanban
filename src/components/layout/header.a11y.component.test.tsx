import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Header } from "./header";
import { signOut } from "next-auth/react";

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { name: "Test User" } } }),
  signOut: vi.fn(),
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "light", resolvedTheme: "light", setTheme: vi.fn() }),
}));
vi.mock("./mobile-sidebar", () => ({ MobileSidebar: () => null }));
vi.mock("./command-palette", () => ({ CommandPalette: () => null }));
vi.mock("./notification-bell", () => ({ NotificationBell: () => null }));

afterEach(cleanup);

function mount() {
  return render(
    <>
      <a href="#board">Перейти к доске</a>
      <Header />
      <main id="board" aria-label="Доска">
        <div className="mb-2 flex-shrink-0">
          <button>Новая задача</button>
        </div>
        <div className="min-h-64">
          <a href="#task">Открыть задачу</a>
          <input aria-label="Фильтр задач" />
        </div>
      </main>
    </>,
  );
}

async function openThemeMenu() {
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Выбрать тему" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menu");
  return { user, trigger };
}

it("keeps the board controls exposed to assistive technology while the theme menu is open", async () => {
  const { container } = mount();
  const { user, trigger } = await openThemeMenu();

  // A non-modal menu leaves the background accessible rather than hiding
  // focusable controls with aria-hidden. Keep the selectors from the axe report.
  for (const selector of [".mb-2.flex-shrink-0", ".min-h-64"]) {
    expect(container.querySelector(selector)?.closest('[aria-hidden="true"]')).toBeNull();
  }
  expect(screen.getByRole("button", { name: "Новая задача" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Открыть задачу" })).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Фильтр задач" })).toBeVisible();
  expect(trigger.closest('[aria-hidden="true"]')).toBeNull();

  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.tab();
  expect(screen.getByRole("button", { name: "Открыть меню пользователя" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Новая задача" })).toHaveFocus();
});

async function openUserMenu() {
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Открыть меню пользователя" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menu");
  return { user, trigger };
}

it("keeps the skip link, header and board accessible while the user menu is open", async () => {
  const { container } = mount();
  const { user, trigger } = await openUserMenu();
  for (const selector of ["a[href='#board']", "header", ".mb-2.flex-shrink-0", ".min-h-64"]) {
    const element = container.querySelector(selector);
    expect(element).not.toBeNull();
    expect(element?.closest('[aria-hidden="true"]')).toBeNull();
  }
  expect(screen.getByRole("link", { name: "Перейти к доске" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Новая задача" })).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Фильтр задач" })).toBeVisible();

  const logout = screen.getByRole("menuitem", { name: "Выйти" });
  await waitFor(() => expect(logout).toHaveFocus());
  await user.keyboard("{ArrowDown}{ArrowUp}");
  expect(logout).toHaveFocus();
  await user.tab();
  expect(logout).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.tab();
  expect(screen.getByRole("button", { name: "Новая задача" })).toHaveFocus();
});

it("allows an outside board action to close the user menu without signing out", async () => {
  mount();
  const { user } = await openUserMenu();
  const boardAction = screen.getByRole("button", { name: "Новая задача" });
  await user.click(boardAction);
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  expect(boardAction).toHaveFocus();
  expect(signOut).not.toHaveBeenCalled();
});

it("preserves the user menu sign-out action and callback", async () => {
  mount();
  const { user } = await openUserMenu();
  await user.keyboard("{Enter}");
  expect(signOut).toHaveBeenCalledExactlyOnceWith({ callbackUrl: "/sign-in" });
});

it("supports menu arrows and Tab, then closes on Escape and restores trigger focus", async () => {
  mount();
  const { user, trigger } = await openThemeMenu();
  const light = screen.getByRole("menuitem", { name: /Светлая/ });
  const dark = screen.getByRole("menuitem", { name: /Темная/ });
  await waitFor(() => expect(light).toHaveFocus());
  await user.keyboard("{ArrowDown}");
  expect(dark).toHaveFocus();
  // Radix menus use arrows between items and prevent Tab from moving into
  // the page while the menu is open, including in non-modal mode.
  await user.tab();
  expect(dark).toHaveFocus();
  expect(screen.getByRole("menu")).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
});
