import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessageDTO } from "@/lib/chat-types";

const runtime = vi.hoisted(() => ({
  socket: { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  apiFetch: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ apiFetch: runtime.apiFetch, apiPost: vi.fn(async () => ({})) }));
vi.mock("@/hooks/useTaskChat", () => ({
  useTaskChat: () => ({ socket: runtime.socket, isConnected: true, isJoined: true, lastError: null }),
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "mobile-user", name: "User", email: "user@example.test", image: null } } }),
}));

import { TaskChatPanel } from "./TaskChatPanel";

const longToken = `https://files.example.invalid/${"segment".repeat(30)}/attachment-name-without-breaks`;

const message: ChatMessageDTO = {
  id: "message-1",
  clientId: null,
  taskId: "task-1",
  authorId: "other",
  author: { id: "other", email: "other@example.test", name: "Константин-Константинопольский-С-Очень-Длинной-Фамилией", avatarUrl: null },
  contentText: `Посмотрите вложение: ${longToken}`,
  attachments: [],
  mentions: [],
  reactions: {},
  createdAt: "2026-10-21T10:00:00Z",
};

function mount(items: ChatMessageDTO[] = []) {
  runtime.apiFetch.mockResolvedValue({ items, nextCursor: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><TaskChatPanel taskId="task-1" /></QueryClientProvider>);
  return { view, client };
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  runtime.apiFetch.mockReset();
  runtime.socket.emit.mockReset();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "visualViewport");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

it("keeps the message field and send action above the safe area with touch-sized controls", async () => {
  mount();
  await screen.findByText("Пока нет сообщений");

  const composer = screen.getByTestId("chat-composer");
  expect(composer).toHaveClass(
    "shrink-0",
    "min-w-0",
    "pb-[max(0.5rem,env(safe-area-inset-bottom))]",
    "pl-[max(0.5rem,env(safe-area-inset-left))]",
    "pr-[max(0.5rem,env(safe-area-inset-right))]",
  );

  const field = screen.getByRole("textbox", { name: "Сообщение" });
  expect(field).toHaveClass("h-11", "min-w-0", "flex-1", "text-base");

  const send = screen.getByRole("button", { name: "Отправить сообщение" });
  expect(send).toHaveClass("h-12", "min-w-11", "shrink-0");
  expect(composer).toContainElement(field);
  expect(composer).toContainElement(send);

  // The chat column itself must be able to shrink inside the card panel.
  const panel = composer.parentElement as HTMLElement;
  expect(panel).toHaveClass("flex", "h-full", "min-h-0", "min-w-0", "flex-col", "overflow-hidden");
});

it("reveals the composer again after the visual viewport shrinks for the keyboard", async () => {
  const listeners = new Set<() => void>();
  const viewport = {
    height: 500,
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "resize") listeners.add(listener);
    }),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  mount();
  await screen.findByText("Пока нет сообщений");

  const field = screen.getByRole("textbox", { name: "Сообщение" });
  const scrollIntoView = HTMLElement.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
  scrollIntoView.mockClear();

  await userEvent.click(field);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

  scrollIntoView.mockClear();
  viewport.height = 320;
  listeners.forEach(listener => listener());
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
});

it("keeps the message list scrollable and the composer compact at a short viewport", async () => {
  mount();
  await screen.findByText("Пока нет сообщений");

  const viewport = document.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement;
  const scrollArea = viewport?.closest(".flex-1.min-h-0") as HTMLElement;
  expect(scrollArea).toHaveClass("flex-1", "min-h-0");

  const hint = screen.getByText(/Enter: новая строка/);
  expect(hint).toHaveClass("[@media(max-height:420px)]:hidden");

  const chatHeader = screen.getByText("Сообщения по обращению").closest(".flex") as HTMLElement;
  expect(chatHeader).toHaveClass("[@media(max-height:420px)]:py-1");

  // The composer never scrolls away with the transcript.
  const composer = screen.getByTestId("chat-composer");
  expect(scrollArea).not.toBeNull();
  expect(scrollArea.contains(composer)).toBe(false);
});

it("wraps long message text and author names inside the message column", async () => {
  mount([message]);
  await screen.findByText(/Посмотрите вложение/);

  const body = screen.getByText(/Посмотрите вложение/);
  expect(body).toHaveClass("[overflow-wrap:anywhere]", "whitespace-pre-wrap");
  expect(body.textContent).toContain(longToken);

  const author = screen.getByText(message.author.name!);
  expect(author).toHaveClass("min-w-0", "[overflow-wrap:anywhere]");

  // The message body must sit in a shrinkable column next to the avatar.
  expect(body.closest(".min-w-0.flex-1")).not.toBeNull();
});
