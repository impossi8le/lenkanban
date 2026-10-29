import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  socket: { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch }));
vi.mock("@/hooks/useTaskChat", () => ({ useTaskChat: () => ({ socket: mocks.socket, isConnected: true, isJoined: true, lastError: null }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "load-error-user", name: "Test", email: "fixture@example.invalid" } } }) }));
import { TaskChatPanel } from "./TaskChatPanel";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

it("distinguishes failed message loading from an empty chat and preserves the draft through a successful retry", async () => {
  let unavailable = true;
  mocks.apiFetch.mockImplementation(async () => {
    if (unavailable) throw Object.assign(new Error("SYNTHETIC_PRIVATE_ERROR_VALUE"), { status: 503 });
    return { items: [], nextCursor: null };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const user = userEvent.setup();
  render(<QueryClientProvider client={client}><TaskChatPanel taskId="load-error-task" /></QueryClientProvider>);

  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить сообщения.");
  expect(screen.queryByText("Пока нет сообщений")).not.toBeInTheDocument();
  expect(screen.queryByText("SYNTHETIC_PRIVATE_ERROR_VALUE")).not.toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: "Сообщение" }), "Синтетический черновик");
  expect(screen.getByRole("button", { name: "Отправить сообщение" })).toBeDisabled();

  unavailable = false;
  await user.click(screen.getByRole("button", { name: "Повторить загрузку сообщений" }));
  expect(await screen.findByText("Пока нет сообщений")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Сообщение" })).toHaveValue("Синтетический черновик");
  await waitFor(() => expect(screen.getByRole("button", { name: "Отправить сообщение" })).toBeEnabled());
  expect(mocks.socket.emit).not.toHaveBeenCalledWith("message:send", expect.anything(), expect.anything());
  client.clear();
});
