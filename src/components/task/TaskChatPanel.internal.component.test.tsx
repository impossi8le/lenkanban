import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatMessageDTO } from "@/lib/chat-types";

const runtime = vi.hoisted(() => ({
  socket: { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  handlers: new Map<string, (...args: unknown[]) => void>(),
  fetch: vi.fn(),
}));

vi.mock("@/hooks/useTaskChat", () => ({
  useTaskChat: () => ({ socket: runtime.socket, isConnected: true, isJoined: true, lastError: null }),
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "user-1", name: "User", email: "user@example.test", image: null } } }),
}));

import { TaskChatPanel } from "./TaskChatPanel";

const publicMessage: ChatMessageDTO & { isInternal?: boolean } = {
  id: "public-1", clientId: null, taskId: "task-1", authorId: "other",
  author: { id: "other", email: "other@example.test", name: "Other", avatarUrl: null },
  contentText: "Обычное сообщение", attachments: [], mentions: [], reactions: {},
  createdAt: "2026-10-21T10:00:00Z",
};

const internalMessage = {
  ...publicMessage,
  id: "internal-1",
  contentText: "Внутреннее сообщение",
  isInternal: true,
};

function respond(canReadInternal: boolean, items: unknown[] = []) {
  runtime.fetch.mockResolvedValue(new Response(JSON.stringify({
    success: true,
    data: { items, nextCursor: null, canReadInternal },
  }), { headers: { "Content-Type": "application/json" } }));
}

function mount() {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><TaskChatPanel taskId="task-1" /></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  runtime.handlers.clear();
  runtime.socket.on.mockReset();
  runtime.socket.off.mockReset();
  runtime.socket.emit.mockReset();
  runtime.fetch.mockReset();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

function install() {
  runtime.socket.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    runtime.handlers.set(event, handler);
  });
  vi.stubGlobal("fetch", runtime.fetch);
}

it.each([true, false])("hides internal composition even when canReadInternal=%s", async canReadInternal => {
  install(); respond(canReadInternal); mount();
  await screen.findByText("Пока нет сообщений");
  expect(screen.queryByLabelText("Внутренний комментарий")).not.toBeInTheDocument();
  expect(document.querySelector('input[type="file"]')).not.toBeDisabled();
});

it("keeps ordinary comments public by default and labels stored internal rows", async () => {
  install();
  respond(true, [publicMessage, internalMessage]);
  mount();

  expect(await screen.findByText("Внутреннее сообщение")).toBeInTheDocument();
  expect(screen.getByText("Внутреннее")).toBeInTheDocument();

  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText("Сообщение... (Enter — отправить)"), "Обычный");
  await user.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => expect(runtime.socket.emit).toHaveBeenCalledWith(
    "message:send",
    expect.objectContaining({ contentText: "Обычный", visibility: "PUBLIC" }),
    expect.any(Function),
  ));
});

it("does not render an internal realtime event for an unconfirmed reader", async () => {
  install();
  respond(false, [publicMessage]);
  mount();
  await screen.findByText("Обычное сообщение");

  const onNew = runtime.handlers.get("message:new");
  expect(onNew).toBeTypeOf("function");
  act(() => onNew!(internalMessage));
  expect(screen.queryByText("Внутреннее сообщение")).not.toBeInTheDocument();

  act(() => onNew!(publicMessage));
  expect(screen.queryByText("Внутреннее")).not.toBeInTheDocument();
});
