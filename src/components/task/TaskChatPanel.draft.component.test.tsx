import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ id: "user-a" as string | undefined }));
const socket = vi.hoisted(() => ({ connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() }));
vi.mock("@/hooks/useTaskChat", () => ({ useTaskChat: () => ({ socket, isConnected: socket.connected, isJoined: socket.connected, lastError: null }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: auth.id ? { user: { id: auth.id, name: "User" } } : null }) }));
import { TaskChatPanel } from "./TaskChatPanel";

let client: QueryClient;
const panel = (taskId = "task-a") => <QueryClientProvider client={client}><TaskChatPanel taskId={taskId} /></QueryClientProvider>;
const input = () => screen.getByPlaceholderText("Сообщение... (Enter — отправить)");
beforeEach(() => {
  // Node's experimental localStorage shadows jsdom's main window storage.
  // A same-origin iframe supplies the real browser Storage implementation.
  const frame = document.createElement("iframe"); document.body.appendChild(frame);
  vi.stubGlobal("localStorage", frame.contentWindow!.localStorage);
  window.localStorage.clear(); auth.id = "user-a";
  socket.connected = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  vi.stubGlobal("fetch", async () => Response.json({ success: true, data: { items: [], nextCursor: null } }));
});
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.querySelectorAll("iframe").forEach(frame => frame.remove()); Reflect.deleteProperty(HTMLElement.prototype, "scrollTo"); });

it("restores unsent text after unmount and reports successful browser persistence", () => {
  const view = render(panel());
  fireEvent.change(input(), { target: { value: "Уточнить срок и результат" } });
  expect(screen.getByRole("status")).toHaveTextContent("Черновик сохранён в этом браузере");
  view.unmount(); render(panel());
  expect(input()).toHaveValue("Уточнить срок и результат");
});

it("keeps task drafts isolated and restores each on switching back", () => {
  const view = render(panel());
  fireEvent.change(input(), { target: { value: "Задача А" } });
  view.rerender(panel("task-b")); expect(input()).toHaveValue("");
  fireEvent.change(input(), { target: { value: "Задача Б" } });
  view.rerender(panel()); expect(input()).toHaveValue("Задача А");
  view.rerender(panel("task-b")); expect(input()).toHaveValue("Задача Б");
});

it("does not display another account's draft on an account switch", () => {
  const view = render(panel()); fireEvent.change(input(), { target: { value: "Личный текст А" } });
  auth.id = "user-b"; view.rerender(panel()); expect(input()).toHaveValue("");
  fireEvent.change(input(), { target: { value: "Личный текст Б" } });
  auth.id = "user-a"; view.rerender(panel()); expect(input()).toHaveValue("Личный текст А");
});

it("waits for account identity before accepting a draft", () => {
  auth.id = undefined; const view = render(panel()); expect(input()).toBeDisabled();
  auth.id = "user-a"; view.rerender(panel()); expect(input()).not.toBeDisabled();
});

it("persists explicit draft clearing", () => {
  let view = render(panel()); fireEvent.change(input(), { target: { value: "Удалить черновик" } });
  view.unmount(); view = render(panel()); expect(input()).toHaveValue("Удалить черновик");
  fireEvent.change(input(), { target: { value: "" } }); view.unmount(); render(panel()); expect(input()).toHaveValue("");
});

it("keeps typed text usable and reports a storage write failure honestly", () => {
  render(panel()); vi.spyOn(Object.getPrototypeOf(window.localStorage), "setItem").mockImplementation(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
  fireEvent.change(input(), { target: { value: "Не потерять текущий ввод" } });
  expect(input()).toHaveValue("Не потерять текущий ввод");
  expect(screen.getByRole("status")).toHaveTextContent("Хранилище черновиков недоступно");
});

it("keeps the persisted draft on offline keyboard submit", () => {
  const view = render(panel()); fireEvent.change(input(), { target: { value: "Без интернета" } });
  fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
  view.unmount(); render(panel()); expect(input()).toHaveValue("Без интернета");
});

it("clears the draft when handed to the existing send queue, without erasing subsequent input", async () => {
  socket.connected = true;
  const view = render(panel()); fireEvent.change(input(), { target: { value: "Отправляемый текст" } });
  fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(client.getQueryData<{ items: { contentText: string }[] }>(["task-messages", "task-a"])?.items.some(item => item.contentText === "Отправляемый текст")).toBe(true));
  expect(input()).toHaveValue(""); view.unmount();
  const next = render(panel()); expect(input()).toHaveValue("");
  fireEvent.change(input(), { target: { value: "Следующее сообщение" } });
  next.unmount(); render(panel()); expect(input()).toHaveValue("Следующее сообщение");
});

it("allows typing when storage reads are blocked and recovers saving when available", () => {
  const read = vi.spyOn(Object.getPrototypeOf(window.localStorage), "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
  render(panel()); expect(input()).not.toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Хранилище черновиков недоступно");
  read.mockRestore(); fireEvent.change(input(), { target: { value: "Восстановлено" } });
  expect(screen.getByRole("status")).toHaveTextContent("Черновик сохранён");
});

it("does not claim successful clearing when storage removal fails", () => {
  render(panel()); fireEvent.change(input(), { target: { value: "Старый текст" } });
  vi.spyOn(Object.getPrototypeOf(window.localStorage), "removeItem").mockImplementation(() => { throw new Error("Blocked"); });
  fireEvent.change(input(), { target: { value: "" } });
  expect(input()).toHaveValue(""); expect(screen.getByRole("status")).toHaveTextContent("Хранилище черновиков недоступно");
});
