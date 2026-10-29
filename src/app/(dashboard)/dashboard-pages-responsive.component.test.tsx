import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  unread: { byTask: {} as Record<string, number>, total: 0, isLoading: false },
  session: { data: { user: { id: "actor-A", name: "Пользователь", email: "user@example.test" } }, status: "authenticated" },
}));

vi.mock("@/lib/api", () => ({ apiFetch: runtime.apiFetch, apiPost: vi.fn() }));
vi.mock("@/hooks/useUnreadCounts", () => ({ useUnreadCounts: () => runtime.unread }));
vi.mock("next-auth/react", () => ({ useSession: () => runtime.session }));

import SettingsPage from "./settings/page";
import MessagesPage from "./messages/page";
import DebugSearchClient from "./debug-search/DebugSearchClient";

const longTitle = `Очень-длинное-название-задачи-без-пробелов-${"сегмент-".repeat(12)}конец`;
const longEmail = `very.long.synthetic.address.for.mobile.${"segment.".repeat(6)}example.test`;

function mount(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  runtime.apiFetch.mockReset();
  runtime.unread.byTask = {};
  runtime.unread.total = 0;
  runtime.unread.isLoading = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function headingLevels() {
  return screen.getAllByRole("heading").map((heading) => Number(heading.tagName.slice(1)));
}
function expectNoSkippedHeadingLevels() {
  const levels = headingLevels();
  expect(levels[0]).toBe(1);
  expect(levels.every((level, index) => index === 0 || level <= levels[index - 1] + 1)).toBe(true);
}

it("gives the settings page mobile padding instead of a fixed 24px gutter", () => {
  mount(<SettingsPage />);
  const page = screen.getByRole("heading", { name: "Настройки" }).closest(".container") as HTMLElement;
  expect(page).toHaveClass("px-4", "sm:px-6");
  expect(page).toHaveClass("min-w-0", "max-w-4xl");
});

it("lets a long task title shrink so the unread badge stays inside the card", async () => {
  runtime.unread.byTask = { "task-1": 3 };
  runtime.unread.total = 3;
  runtime.apiFetch.mockImplementation(async (url: string) => {
    if (url === "/api/messages/threads") {
      return {
        items: [{
          id: "task-1",
          title: longTitle,
          projectId: "project-1",
          projectName: "Доска",
          lastMessage: { contentText: longTitle, createdAt: "2026-10-21T10:00:00Z", authorName: longEmail },
          unreadCount: 3,
        }],
        total: 3,
      };
    }
    return { items: [], total: 0 };
  });

  mount(<MessagesPage />);

  const title = await screen.findByRole("heading", { name: longTitle });
  // A `truncate` flex item keeps min-width:auto unless it is explicitly allowed
  // to shrink; otherwise the badge and the row are pushed past the card edge.
  expect(title).toHaveClass("min-w-0", "truncate");
  expect(title.parentElement).toHaveClass("min-w-0");
  expect(title.closest(".flex-1")).toHaveClass("min-w-0");

  const page = title.closest(".container") as HTMLElement;
  expect(page).toHaveClass("min-w-0", "px-4", "sm:px-6");
});

it("wraps the diagnostic session email instead of widening the debug page", () => {
  runtime.session.data.user.email = longEmail;
  mount(<DebugSearchClient />);

  const email = screen.getByText(/Email:/).closest("p") as HTMLElement;
  expect(email).toHaveTextContent(longEmail);
  expect(email).toHaveClass("[overflow-wrap:anywhere]");
  const page = screen.getByRole("heading", { name: "Диагностика Поиска" }).closest("div.container") as HTMLElement;
  expect(page).toHaveClass("min-w-0", "p-4", "sm:p-6");
});

it("keeps the messages page heading hierarchy without skipped levels", async () => {
  runtime.unread.byTask = { "task-1": 2 };
  runtime.unread.total = 2;
  runtime.apiFetch.mockImplementation(async (url: string) => {
    if (url === "/api/messages/threads") {
      return {
        items: [{
          id: "task-1",
          title: "Задача",
          projectId: "project-1",
          projectName: "Проект",
          lastMessage: { contentText: "Текст", createdAt: "2026-10-21T10:00:00Z", authorName: "Иван" },
          unreadCount: 2,
        }],
        total: 2,
      };
    }
    return { items: [], total: 0 };
  });

  mount(<MessagesPage />);

  expect(screen.getByRole("heading", { name: "Сообщения" }).tagName).toBe("H1");
  expect((await screen.findByRole("heading", { name: "Проект" })).tagName).toBe("H2");
  expect((await screen.findByRole("heading", { name: "Задача" })).tagName).toBe("H3");
  expectNoSkippedHeadingLevels();
});

it("keeps the debug search page heading hierarchy without skipped levels", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    status: 200,
    ok: true,
    headers: new Map([["content-type", "application/json"]]),
    json: async () => ({ url }),
    text: async () => "",
  })));

  mount(<DebugSearchClient />);

  expect(screen.getByRole("heading", { name: "Диагностика Поиска" }).tagName).toBe("H1");
  expect(screen.getByRole("heading", { name: "Тест Поиска" }).tagName).toBe("H2");
  fireEvent.click(screen.getByRole("button", { name: "Тест" }));

  expect((await screen.findByRole("heading", { name: "Результат /api/tasks:" })).tagName).toBe("H3");
  expect((await screen.findByRole("heading", { name: "Результат /api/projects:" })).tagName).toBe("H3");
  expectNoSkippedHeadingLevels();
});
