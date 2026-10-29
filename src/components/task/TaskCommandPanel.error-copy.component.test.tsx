import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";

const mocks = vi.hoisted(() => ({ read: vi.fn(), patch: vi.fn(), info: vi.fn(), close: vi.fn() }));
vi.mock("@/lib/task-scalar-transport", async original => ({ ...await original<typeof import("@/lib/task-scalar-transport")>(), readTaskDetails: mocks.read, patchScalarCommand: mocks.patch }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => ({ taskId: "task", projectId: "project", version: 7, marked: false, deleted: false, permissions: {} })) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: "actor" } } }) }));
vi.mock("@/hooks/useTaskDetailRealtime", () => ({ useTaskDetailRealtime: () => undefined }));
vi.mock("@/lib/telemetry/client", () => ({ getBrowserTelemetryClient: () => undefined }));
vi.mock("sonner", () => ({ toast: { info: mocks.info, error: vi.fn(), success: vi.fn() } }));
vi.mock("./TaskDetailPanel", () => ({ TaskDetailPanel: ({ task, onSave, onClose, saveStatus }: {
  task: TaskType; onSave: (id: string, data: { title: string }) => void; onClose: () => void; saveStatus: import("react").ReactNode;
}) => <div>{saveStatus}<button onClick={() => onSave(task.id, { title: "Изменённая тема" })}>Сохранить тему</button><button onClick={onClose}>Закрыть карточку</button></div> }));
import { TaskCommandPanel } from "./TaskCommandPanel";

const task: TaskType = { id: "task", projectId: "project", title: "Тема", priority: "LOW", version: 7, position: 1 };
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks(); mocks.patch.mockReset(); mocks.read.mockReset();
  mocks.patch.mockResolvedValue({ taskId: "task", projectId: "project", version: 8 });
  mocks.read.mockResolvedValue({ ...task, title: "Изменённая тема", version: 8 });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); });
function mount() { render(<QueryClientProvider client={client}><TaskCommandPanel task={task} taskId="task" projectId="project" onClose={mocks.close} /></QueryClientProvider>); }
function save() { fireEvent.click(screen.getByRole("button", { name: "Сохранить тему" })); }
function closeBlocked(message: string, banner: HTMLElement, focusBanner = true) {
  const close = screen.getByRole("button", { name: "Закрыть карточку" }); close.focus(); fireEvent.click(close);
  expect(mocks.close).not.toHaveBeenCalled(); expect(mocks.info).toHaveBeenLastCalledWith(message);
  if (focusBanner) expect(banner).toHaveFocus(); else expect(close).toHaveFocus();
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it("explains a known conflict with one concrete refresh action and blocks closing without replay", async () => {
  mocks.patch.mockRejectedValueOnce(Object.assign(new Error("synthetic"), { status: 409 })); mount(); save();
  const refresh = await screen.findByRole("button", { name: "Обновить карточку" });
  const banner = screen.getByRole("alert");
  expect(banner).toHaveTextContent("Не удалось сохранить изменение. Обновите карточку и повторите действие.");
  await waitFor(() => expect(banner).toHaveFocus());
  closeBlocked("Сначала нажмите «Обновить карточку», затем повторите действие.", banner);
  expect(mocks.patch).toHaveBeenCalledOnce(); fireEvent.click(refresh);
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(mocks.read).toHaveBeenCalledOnce(); expect(mocks.patch).toHaveBeenCalledOnce();
});

it("distinguishes an unsupported parameter and points blocked close to the same refresh action", async () => {
  mocks.patch.mockRejectedValueOnce(Object.assign(new Error("synthetic"), { status: 409, payload: { error: { code: "REQUEST_LIFECYCLE_NOT_ENABLED" } } })); mount(); save();
  await screen.findByRole("button", { name: "Обновить карточку" });
  const banner = screen.getByRole("alert");
  expect(banner).toHaveTextContent("Этот параметр сейчас нельзя изменить. Обновите карточку, чтобы увидеть доступные действия.");
  expect(banner).not.toHaveTextContent("Изменение не сохранено");
  closeBlocked("Сначала нажмите «Обновить карточку», затем повторите действие.", banner);
  expect(mocks.patch).toHaveBeenCalledOnce();
});

it("keeps an uncertain save uncertain and retries the exact existing command", async () => {
  mocks.patch.mockRejectedValueOnce(new TypeError("synthetic lost response")); mount(); save();
  const retry = await screen.findByRole("button", { name: "Повторить сохранение" });
  const banner = screen.getByRole("alert");
  expect(banner).toHaveTextContent("Сервер не подтвердил сохранение."); expect(banner).not.toHaveTextContent("не сохранено");
  closeBlocked("Сначала нажмите «Повторить сохранение» в карточке.", banner);
  const original = mocks.patch.mock.calls[0][0]; save(); expect(mocks.patch).toHaveBeenCalledOnce();
  fireEvent.click(retry); await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
  expect(mocks.patch.mock.calls[1][0]).toEqual(original);
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});

it("offers read recovery after a confirmed write without sending the mutation again", async () => {
  mocks.read.mockRejectedValueOnce(Object.assign(new Error("synthetic"), { status: 503 })); mount(); save();
  const refresh = await screen.findByRole("button", { name: "Обновить карточку" });
  const banner = screen.getByRole("alert"); expect(banner).toHaveTextContent("Не удалось загрузить актуальные данные.");
  closeBlocked("Сначала нажмите «Обновить карточку», затем повторите действие.", banner);
  fireEvent.click(refresh); await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(mocks.read).toHaveBeenCalledTimes(2); expect(mocks.patch).toHaveBeenCalledOnce();
});

it("asks the user to wait while saving and reading, preserving both close guards", async () => {
  const write = deferred<{ taskId: string; projectId: string; version: number }>(); const read = deferred<TaskType>();
  mocks.patch.mockReturnValueOnce(write.promise); mocks.read.mockReturnValueOnce(read.promise); mount(); save();
  closeBlocked("Дождитесь окончания сохранения.", screen.getByRole("status"), false);
  await act(async () => write.resolve({ taskId: "task", projectId: "project", version: 8 }));
  expect(screen.getByRole("status")).toHaveTextContent("Обновляем карточку…");
  closeBlocked("Дождитесь обновления карточки.", screen.getByRole("status"), false);
  await act(async () => read.resolve({ ...task, version: 8, title: "Изменённая тема" }));
  fireEvent.click(screen.getByRole("button", { name: "Закрыть карточку" })); expect(mocks.close).toHaveBeenCalledOnce();
});
