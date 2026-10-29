import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  unread: { byTask: {} as Record<string, number>, total: 0, isLoading: false },
}));

vi.mock("@/lib/api", () => ({ apiFetch: runtime.apiFetch, apiPost: vi.fn() }));
vi.mock("@/hooks/useUnreadCounts", () => ({ useUnreadCounts: () => runtime.unread }));

import MessagesPage from "./page";

const clients: QueryClient[] = [];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MessagesPage />
    </QueryClientProvider>
  );
}

type Thread = {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  lastMessage: { contentText: string; createdAt: string; authorName: string } | null;
  unreadCount: number;
};

function thread(index: number, projectId = "project-1"): Thread {
  return {
    id: `task-${index}`,
    title: `Задача ${index}`,
    projectId,
    projectName: `Проект ${projectId}`,
    lastMessage: {
      contentText: `Текст ${index}`,
      createdAt: "2026-10-21T10:00:00.000Z",
      authorName: "Иван",
    },
    unreadCount: 1,
  };
}

/**
 * The list must be rendered from the batch endpoint only. The legacy per-task
 * shape is still answered so the pre-fix implementation can run and expose its
 * request count instead of crashing on an unexpected mock.
 */
function serveBatch(items: Thread[]) {
  runtime.apiFetch.mockImplementation(async (url: string) => {
    if (url === "/api/messages/threads") return { items, total: items.length };
    if (url.includes("/messages?")) return { items: [] };
    return { id: "task", title: "Задача", projectId: "project-1", project: { name: "Проект" } };
  });
}

beforeEach(() => {
  runtime.apiFetch.mockReset();
  runtime.unread.byTask = {};
  runtime.unread.total = 0;
  runtime.unread.isLoading = false;
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
});

it("renders 20 unread discussions with one batch request instead of two per task", async () => {
  const items = Array.from({ length: 20 }, (_, index) => thread(index));
  runtime.unread.byTask = Object.fromEntries(items.map(item => [item.id, item.unreadCount]));
  runtime.unread.total = 20;
  serveBatch(items);

  mount();

  expect(await screen.findByRole("heading", { name: "Задача 0" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Задача 19" })).toBeInTheDocument();

  const urls = runtime.apiFetch.mock.calls.map(call => String(call[0]));
  expect(urls).toEqual(["/api/messages/threads"]);
});

it("renders only the tasks the server included in the batch response", async () => {
  runtime.unread.byTask = { visible: 2, foreign: 5 };
  runtime.unread.total = 7;
  serveBatch([{ ...thread(0), id: "visible", title: "Видимая задача", unreadCount: 2 }]);

  mount();

  expect(await screen.findByRole("heading", { name: "Видимая задача" })).toBeInTheDocument();
  expect(screen.queryByText(/foreign/)).toBeNull();
  expect(within(screen.getByRole("link", { name: /Видимая задача/ })).getByText("2")).toBeInTheDocument();
  expect(runtime.apiFetch.mock.calls.map(call => String(call[0]))).toEqual(["/api/messages/threads"]);
});

it("groups the batch rows by project without extra requests", async () => {
  runtime.unread.byTask = { a: 1, b: 1 };
  runtime.unread.total = 2;
  serveBatch([thread(1, "alpha"), thread(2, "beta")]);

  mount();

  expect(await screen.findByRole("heading", { name: "Проект alpha" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Проект beta" })).toBeInTheDocument();
  expect(runtime.apiFetch).toHaveBeenCalledTimes(1);
});

it("shows the empty state and performs no request when nothing is unread", async () => {
  mount();

  expect(await screen.findAllByText("Нет непрочитанных сообщений")).toHaveLength(2);
  expect(runtime.apiFetch).not.toHaveBeenCalled();
});

it("shows a fixed failure message instead of the server error text", async () => {
  runtime.unread.byTask = { "task-1": 1 };
  runtime.unread.total = 1;
  runtime.apiFetch.mockRejectedValue(new Error("private-details"));

  mount();

  expect(await screen.findByText(/Не удалось загрузить сообщения/)).toBeInTheDocument();
  expect(screen.queryByText(/private-details/)).toBeNull();
});
