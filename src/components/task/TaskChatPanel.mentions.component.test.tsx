import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ actor: "actor-a", api: vi.fn(), post: vi.fn(), socket: { connected: true, emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));
vi.mock("@/lib/api", () => ({ apiFetch: state.api, apiPost: state.post }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: state.actor, name: "Автор" } } }) }));
vi.mock("@/hooks/useTaskChat", () => ({ useTaskChat: () => ({ socket: state.socket, isConnected: true, isJoined: true, lastError: null }) }));
import { TaskChatPanel } from "./TaskChatPanel";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

let client: QueryClient;
function panel(task = "mention-task") { return <QueryClientProvider client={client}><TaskChatPanel taskId={task} /></QueryClientProvider>; }
const field = () => screen.getByRole("textbox", { name: "Сообщение" });
beforeEach(() => {
  state.actor = "actor-a"; state.api.mockReset(); state.post.mockReset(); state.socket.emit.mockReset(); state.socket.on.mockReset();
  const frame = document.createElement("iframe"); document.body.appendChild(frame);
  vi.stubGlobal("localStorage", frame.contentWindow!.localStorage); vi.stubGlobal("sessionStorage", frame.contentWindow!.sessionStorage);
  localStorage.clear(); sessionStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  state.api.mockImplementation(async (path: string) => path.includes("mention-candidates") ? { items: [{ id: "recipient", name: "Анна Петрова", departmentName: "ИТ" }] } : { items: [], nextCursor: null });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); document.querySelectorAll("iframe").forEach(frame => frame.remove()); });

async function choose() {
  fireEvent.click(screen.getByRole("button", { name: "Упомянуть человека" }));
  fireEvent.click(await screen.findByRole("option", { name: /Анна Петрова/ }));
}
it("fetches only while open, inserts a plain name and removes explicit notification recipients independently", async () => {
  render(panel()); await screen.findByText("Пока нет сообщений");
  expect(state.api.mock.calls.some(([path]) => path.includes("mention-candidates"))).toBe(false);
  await choose(); expect(field()).toHaveValue("@Анна Петрова ");
  const candidateCall = state.api.mock.calls.find(([path]) => path.includes("mention-candidates"));
  expect(candidateCall?.[1]).toEqual(expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
  fireEvent.click(screen.getByRole("button", { name: "Убрать упоминание: Анна Петрова" }));
  expect(field()).toHaveValue("@Анна Петрова ");
  expect(screen.queryByLabelText("Получатели упоминаний")).toBeNull();
});

it("uses Arrow/Enter to choose after @ without sending, Escape dismisses and IME never selects", async () => {
  render(panel()); await screen.findByText("Пока нет сообщений");
  fireEvent.change(field(), { target: { value: "Привет @Ан", selectionStart: 10 } });
  await screen.findByRole("option", { name: /Анна Петрова/ });
  fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
  expect(screen.queryByLabelText("Получатели упоминаний")).toBeNull();
  fireEvent.keyDown(field(), { key: "ArrowDown" }); fireEvent.keyDown(field(), { key: "Enter" });
  expect(field()).toHaveValue("Привет @Анна Петрова ");
  expect(state.socket.emit.mock.calls.some(([event]) => event === "message:send")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Упомянуть человека" }));
  fireEvent.keyDown(field(), { key: "Escape" }); expect(screen.queryByRole("listbox")).toBeNull();
});

it("sends explicit IDs, retains text/selection on rejection and retries the same IDs", async () => {
  state.socket.emit.mockImplementation((event, _payload, ack) => { if (event === "message:send") ack?.({ ok: false, error: "MENTION_RECIPIENT_UNAVAILABLE" }); });
  render(panel()); await screen.findByText("Пока нет сообщений"); await choose();
  fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
  await waitFor(() => expect(state.socket.emit).toHaveBeenCalledWith("message:send", expect.objectContaining({ mentionUserIds: ["recipient"] }), expect.any(Function)));
  expect(await screen.findByRole("alert")).toHaveTextContent("Текст сообщения сохранён");
  expect(field()).toHaveValue("@Анна Петрова"); expect(screen.getByLabelText("Получатели упоминаний")).toHaveTextContent("Анна Петрова");
  fireEvent.click(screen.getByRole("button", { name: "повторить" }));
  await waitFor(() => expect(state.socket.emit.mock.calls.filter(([event]) => event === "message:send")).toHaveLength(2));
  const sends = state.socket.emit.mock.calls.filter(([event]) => event === "message:send");
  expect(sends[1][1]).toMatchObject({ mentionUserIds: ["recipient"], clientId: sends[0][1].clientId });
});

it("restores explicit metadata per actor/task and never flashes another actor's selection", async () => {
  const view = render(panel()); await screen.findByText("Пока нет сообщений"); await choose();
  view.unmount(); const next = render(panel()); expect(screen.getByLabelText("Получатели упоминаний")).toHaveTextContent("Анна Петрова");
  next.rerender(panel("other-task")); expect(screen.queryByLabelText("Получатели упоминаний")).toBeNull();
  next.rerender(panel()); expect(screen.getByLabelText("Получатели упоминаний")).toBeInTheDocument();
  state.actor = "actor-b"; next.rerender(panel()); expect(screen.queryByLabelText("Получатели упоминаний")).toBeNull(); expect(field()).toHaveValue("");
});

it("shows useful empty/error states and debounces searches without exposing unavailable people", async () => {
  state.api.mockImplementation(async (path: string) => path.includes("mention-candidates") ? { items: [] } : { items: [], nextCursor: null });
  render(panel()); await screen.findByText("Пока нет сообщений"); fireEvent.click(screen.getByRole("button", { name: "Упомянуть человека" }));
  expect(screen.getByText("Ищем сотрудников с доступом…")).toHaveAttribute("role", "status");
  await screen.findByText(/Среди сотрудников с доступом никого не найдено/);
  state.api.mockImplementation(async (path: string) => { if (path.includes("mention-candidates")) throw new Error("failure"); return { items: [], nextCursor: null }; });
  fireEvent.change(screen.getByRole("textbox", { name: "Найти человека для упоминания" }), { target: { value: "Нет" } });
  expect(screen.queryByText(/Среди сотрудников с доступом никого не найдено/)).toBeNull();
  await screen.findByText(/Не удалось загрузить сотрудников/);
  expect(state.api.mock.calls.filter(([path]) => path.includes("mention-candidates"))).toHaveLength(2);
  await act(async () => {});
});

it("does not mistake a restored plain @name for an explicit notification recipient", async () => {
  localStorage.setItem(`lenkanban:chat-draft:v1:${JSON.stringify(["actor-a", "mention-task"])}`, "@Анна Петрова");
  render(panel()); await screen.findByText("Пока нет сообщений");
  expect(screen.getByText(/В тексте есть @, но получатели не выбраны/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
  await waitFor(() => expect(state.socket.emit).toHaveBeenCalledWith("message:send", expect.objectContaining({ mentionUserIds: [] }), expect.any(Function)));
});

it("warns when mention metadata cannot be restored and rejects selecting a 21st recipient", async () => {
  const key = `lenkanban:chat-mentions:v1:${JSON.stringify(["actor-a", "mention-task"])}`;
  sessionStorage.setItem(key, "not json"); const view = render(panel());
  expect(screen.getByText(/Не удалось восстановить или сохранить упоминания/)).toBeInTheDocument();
  view.unmount(); sessionStorage.setItem(key, JSON.stringify(Array.from({ length: 20 }, (_, id) => ({ id: `selected-${id}`, name: `Сотрудник ${id}` }))));
  render(panel()); await screen.findByText("Пока нет сообщений");
  fireEvent.click(screen.getByRole("button", { name: "Упомянуть человека" }));
  expect(await screen.findByRole("option", { name: /Анна Петрова/ })).toBeDisabled();
  expect(screen.getAllByRole("button", { name: /Убрать упоминание:/ })).toHaveLength(20);
});

it("continues ordinary text after a chosen mention and Enter sends exactly once", async () => {
  render(panel()); await screen.findByText("Пока нет сообщений"); await choose();
  fireEvent.change(field(), { target: { value: "@Анна Петрова посмотри", selectionStart: 21 } });
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.keyDown(field(), { key: "Enter" });
  await waitFor(() => expect(state.socket.emit.mock.calls.filter(([event]) => event === "message:send")).toHaveLength(1));
  expect(state.socket.emit).toHaveBeenCalledWith("message:send", expect.objectContaining({ mentionUserIds: ["recipient"], contentText: "@Анна Петрова посмотри" }), expect.any(Function));
});

it("keeps an escaped @ trigger dismissed while typing but allows a new @ trigger", async () => {
  render(panel()); await screen.findByText("Пока нет сообщений");
  fireEvent.change(field(), { target: { value: "@Ан", selectionStart: 3 } });
  await screen.findByRole("option", { name: /Анна Петрова/ });
  fireEvent.keyDown(field(), { key: "Escape" });
  fireEvent.change(field(), { target: { value: "@Ан посмотри", selectionStart: 12 } });
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
  expect(state.socket.emit.mock.calls.some(([event]) => event === "message:send")).toBe(false);
  fireEvent.keyDown(field(), { key: "Enter" });
  await waitFor(() => expect(state.socket.emit.mock.calls.filter(([event]) => event === "message:send")).toHaveLength(1));
  fireEvent.change(field(), { target: { value: "@Ан посмотри @Пе", selectionStart: 16 } });
  await screen.findByRole("option", { name: /Анна Петрова/ });
});

it("distinguishes a connection failure from a recipient access refusal without raw errors", async () => {
  state.socket.emit.mockImplementation((event, _payload, ack) => { if (event === "message:send") ack?.({ ok: false, error: "Send disconnected" }); });
  render(panel()); await screen.findByText("Пока нет сообщений"); await choose();
  fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Нет соединения с обсуждением");
  expect(screen.getByRole("alert")).not.toHaveTextContent("доступ одного");
  expect(field()).toHaveValue("@Анна Петрова");
  expect(screen.getByLabelText("Получатели упоминаний")).toHaveTextContent("Анна Петрова");
});

it("portals the picker outside clipped chat ancestors while preserving @ typing focus and Enter selection", async () => {
  const view = render(<div data-testid="clipped-chat" style={{ overflow: "hidden", height: 160 }}>{panel()}</div>);
  await screen.findByText("Пока нет сообщений");
  field().focus(); fireEvent.change(field(), { target: { value: "@Ан", selectionStart: 3 } });
  await screen.findByRole("option", { name: /Анна Петрова/ });
  const picker = screen.getByRole("dialog", { name: "Выбор человека для упоминания" });
  expect(view.container.contains(picker)).toBe(false);
  expect(document.body.contains(picker)).toBe(true);
  expect(picker).toHaveClass("max-w-[95vw]", "overflow-y-auto", "max-h-[min(70dvh,var(--radix-popover-content-available-height))]");
  expect(field()).toHaveFocus();
  fireEvent.keyDown(field(), { key: "Enter" });
  expect(field()).toHaveValue("@Анна Петрова "); expect(field()).toHaveFocus();
  expect(state.socket.emit.mock.calls.some(([event]) => event === "message:send")).toBe(false);
});

it("focuses portaled search for the explicit button and restores composer focus after picking", async () => {
  render(panel()); await screen.findByText("Пока нет сообщений");
  fireEvent.click(screen.getByRole("button", { name: "Упомянуть человека" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Найти человека для упоминания" })).toHaveFocus());
  fireEvent.click(await screen.findByRole("option", { name: /Анна Петрова/ }));
  await waitFor(() => expect(field()).toHaveFocus());
});

it("keeps textarea focus and portaled options usable inside the real task dialog focus scope", async () => {
  render(<Dialog open><DialogContent aria-describedby={undefined}><DialogTitle>Обращение</DialogTitle><div style={{ height: 380, overflow: "hidden" }}>{panel()}</div></DialogContent></Dialog>);
  await screen.findByText("Пока нет сообщений");
  field().focus(); fireEvent.change(field(), { target: { value: "@Ан", selectionStart: 3 } });
  const option = await screen.findByRole("option", { name: /Анна Петрова/ });
  expect(field()).toHaveFocus();
  expect(screen.getByRole("dialog", { name: "Обращение" }).contains(option)).toBe(false);
  fireEvent.click(option); await waitFor(() => expect(field()).toHaveFocus());
  expect(field()).toHaveValue("@Анна Петрова ");
  expect(screen.getByRole("dialog", { name: "Обращение" })).toBeInTheDocument();
});
