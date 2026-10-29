import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";

const api = vi.hoisted(() => ({ read: vi.fn(), post: vi.fn(), patch: vi.fn(), actor: "author" }));
vi.mock("@/lib/api", () => ({ apiFetch: api.read, apiPost: api.post, apiPatch: api.patch, apiDelete: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: api.actor } } }) }));
vi.mock("next/dynamic", () => ({ default: (loader: () => unknown) => function Editor(props: { content: string; editable?: boolean; onChange: (value: string) => void; onSave: () => void }) {
  return loader.toString().includes("RichTextEditor") ? <><textarea aria-label="Описание проверки прав" value={props.content} readOnly={!props.editable} onChange={event => props.onChange(event.target.value)} /><button onClick={props.onSave}>Сохранить описание</button></> : null;
} }));
vi.mock("@/components/task/ActivityTimeline", () => ({ ActivityTimeline: () => null }));
vi.mock("@/components/task/TaskAttachments", () => ({ TaskAttachments: () => null }));
vi.mock("@/components/task/AssigneeSelector", () => ({ AssigneeSelector: () => <button>Legacy assignment editor</button> }));
vi.mock("@/hooks/useTaskDetailRealtime", () => ({ useTaskDetailRealtime: () => undefined }));
vi.mock("@/lib/telemetry/client", () => ({ getBrowserTelemetryClient: () => undefined }));
import { TaskCommandPanel } from "./TaskCommandPanel";

const task: TaskType = { id: "task", projectId: "project", title: "Заявка", description: "Описание", priority: "LOW", version: 7, position: 1,
  request: { state: "SUBMITTED", executorId: null }, assignees: [] };
const snapshot = { taskId: "task", projectId: "project", version: 7, marked: true, deleted: false, state: "SUBMITTED", authorId: "author", executorId: null, executorName: null,
  permissions: { isAuthor: true, isExecutor: false, isLeader: false, isGroupMember: false, canParticipate: true, canExecute: false, canAssign: false,
    canEditFields: false, canEditDescription: true, canSetDeadline: false }, assignees: null, attachments: [] };
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks(); api.actor = "author";
  const frame = document.createElement("iframe"); document.body.appendChild(frame); vi.stubGlobal("localStorage", frame.contentWindow!.localStorage); localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); api.read.mockResolvedValue(snapshot);
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); document.querySelectorAll("iframe").forEach(frame => frame.remove()); });
function mount(current: TaskType = task) { return render(<QueryClientProvider client={client}><TaskCommandPanel task={current} projectId="project" taskId="task" onClose={vi.fn()} /></QueryClientProvider>); }

it("offers a submitted author description editing without forbidden scalar or legacy assignment editors", async () => {
  mount();
  await screen.findByRole("button", { name: "Отменить обращение" });
  expect(screen.queryByRole("button", { name: "Удалить" })).not.toBeInTheDocument();
  expect(api.read.mock.calls.filter(([path]) => String(path).endsWith("/lifecycle"))).toHaveLength(1); // Parent/actions share one lifecycle GET; watchers use a separate endpoint.
  expect(screen.queryByRole("button", { name: "Изменить тему обращения" })).not.toBeInTheDocument();
  expect(screen.queryByText("Изменить параметры обращения")).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Приоритет задачи" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Legacy assignment editor" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Изменить описание" }));
  expect(screen.getByRole("textbox", { name: "Описание проверки прав" })).not.toHaveAttribute("readonly");
  expect(api.patch).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

it("does not offer mutations while the server capability read is pending or unavailable", async () => {
  api.read.mockReturnValue(new Promise(() => undefined)); mount();
  expect(screen.queryByRole("button", { name: "Изменить тему обращения" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Изменить описание" })).not.toBeInTheDocument();
  expect(screen.queryByText("Изменить параметры обращения")).not.toBeInTheDocument();
});

it.each([undefined, -1, 2147483648])("requires a valid command version even when malformed snapshots agree on %s", async version => {
  api.read.mockResolvedValue({ ...snapshot, version, marked: false, state: null, permissions: { ...snapshot.permissions, canEditFields: true } });
  mount({ ...task, request: null, version });
  await screen.findByRole("button", { name: "Отправить обращение" });
  expect(screen.queryByRole("button", { name: "Изменить тему обращения" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Изменить описание" })).not.toBeInTheDocument();
});

it("does not expose description editing to a read-only watcher", async () => {
  api.actor = "watcher";
  api.read.mockResolvedValue({ ...snapshot, permissions: { ...snapshot.permissions, isAuthor: false, canEditDescription: false } });
  mount(); await waitFor(() => expect(api.read).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Изменить описание" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Описание проверки прав" })).toHaveAttribute("readonly");
});

it("retains the author's supported canonical description save with its original version", async () => {
  let saved = false;
  api.read.mockImplementation(async (path: string) => path.endsWith("/lifecycle") ? { ...snapshot, version: saved ? 8 : 7 } : { ...task, version: 8, description: "Уточнение" });
  api.post.mockImplementation(async () => { saved = true; return { taskId: "task", projectId: "project", version: 8, changed: true, replayed: false }; });
  mount(); await screen.findByRole("button", { name: "Изменить описание" });
  fireEvent.click(screen.getByRole("button", { name: "Изменить описание" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Описание проверки прав" }), { target: { value: "Уточнение" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить описание" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
  expect(api.post.mock.calls[0][1]).toMatchObject({ action: "edit_description", expectedVersion: 7, description: "Уточнение", operationId: expect.any(String) });
  expect(api.patch).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByText("Сохранение изменений…")).not.toBeInTheDocument());
});

it("keeps canonical take available to an unassigned group member without offering legacy fields", async () => {
  api.actor = "support";
  api.read.mockResolvedValue({ ...snapshot, permissions: { ...snapshot.permissions, isAuthor: false, isGroupMember: true, canExecute: true, canEditDescription: false } });
  mount(); await screen.findByRole("button", { name: "Взять в работу" });
  expect(screen.queryByText("Изменить параметры обращения")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Изменить описание" })).not.toBeInTheDocument();
});

it.each(["executor", "leader"])("keeps canonical assignment for %s without unsupported scalar writers", async actor => {
  api.actor = actor;
  api.read.mockResolvedValue({ ...snapshot, state: "IN_PROGRESS", executorId: "executor", permissions: { ...snapshot.permissions,
    isAuthor: false, isExecutor: actor === "executor", isLeader: actor === "leader", isGroupMember: true, canExecute: true, canAssign: true, canEditDescription: actor === "executor" }, assignees: [] });
  mount({ ...task, request: { state: "IN_PROGRESS", executorId: "executor" } });
  await screen.findByRole("button", { name: "Передать другому исполнителю" });
  expect(screen.queryByText("Изменить параметры обращения")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Legacy assignment editor" })).not.toBeInTheDocument();
  expect(Boolean(screen.queryByRole("button", { name: "Изменить описание" }))).toBe(actor === "executor");
});

it("keeps a task-only legacy reader read-only despite missing a request marker", async () => {
  api.read.mockResolvedValue({ ...snapshot, marked: false, state: null, permissions: { ...snapshot.permissions, canEditDescription: false } });
  mount({ ...task, request: null }); await screen.findByRole("button", { name: "Отправить обращение" });
  expect(screen.queryByRole("button", { name: "Изменить тему обращения" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Изменить описание" })).not.toBeInTheDocument();
  expect(screen.queryByText("Изменить параметры обращения")).not.toBeInTheDocument();
});

it("keeps writable legacy fields and actual executor deadline available", async () => {
  api.read.mockResolvedValue({ ...snapshot, marked: false, state: null, permissions: { ...snapshot.permissions, canEditFields: true, canSetDeadline: true, canUseLegacyAssignees: true } });
  mount({ ...task, request: null, deadline: new Date("2026-11-01T12:00:00Z") });
  await screen.findByRole("button", { name: "Изменить тему обращения" });
  expect(screen.getByText("Изменить параметры обращения")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Очистить дедлайн" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Legacy assignment editor" })).toBeInTheDocument();
});

it("offers only the independently granted deadline editor for partial scalar capabilities", async () => {
  api.read.mockResolvedValue({ ...snapshot, marked: false, state: null, permissions: { ...snapshot.permissions, canEditFields: false, canSetDeadline: true } });
  mount({ ...task, request: null, deadline: new Date("2026-11-01T12:00:00Z") });
  await screen.findByRole("button", { name: "Очистить дедлайн" });
  expect(screen.queryByRole("combobox", { name: "Приоритет задачи" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Изменить тему обращения" })).not.toBeInTheDocument();
  expect(screen.queryByText("Срок")).not.toBeInTheDocument();
  expect(screen.getAllByText("Срок выполнения")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Legacy assignment editor" })).not.toBeInTheDocument();
});

it("does not retain cached editing controls after the capability read fails", async () => {
  api.read.mockResolvedValue({ ...snapshot, marked: false, state: null, permissions: { ...snapshot.permissions, canEditFields: true } });
  mount({ ...task, request: null }); await screen.findByRole("button", { name: "Изменить тему обращения" });
  api.read.mockRejectedValue(new Error("synthetic unavailable"));
  await act(() => client.invalidateQueries({ queryKey: ["task-lifecycle", "task"] }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Изменить тему обращения" })).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Изменить описание" })).not.toBeInTheDocument();
});

it("hides an old actor's capability snapshot after account rotation", async () => {
  const current = { ...task, request: null };
  api.read.mockResolvedValue({ ...snapshot, marked: false, state: null, permissions: { ...snapshot.permissions, canEditFields: true } });
  const view = mount(current); await screen.findByRole("button", { name: "Изменить тему обращения" });
  api.actor = "next-actor";
  view.rerender(<QueryClientProvider client={client}><TaskCommandPanel task={current} projectId="project" taskId="task" onClose={vi.fn()} /></QueryClientProvider>);
  expect(screen.getByRole("alert")).toHaveTextContent("Учётная запись изменилась");
  expect(screen.queryByRole("button", { name: "Изменить тему обращения" })).not.toBeInTheDocument();
});

it("rolls a rejected priority back to the confirmed value and offers only explicit read recovery", async () => {
  const current = { ...task, request: null };
  const legacy = { ...snapshot, marked: false, state: null, permissions: { ...snapshot.permissions, canEditFields: true } };
  api.read.mockImplementation(async (path: string) => path.endsWith("/lifecycle") ? legacy : current);
  api.patch.mockRejectedValue(Object.assign(new Error("unsupported"), { status: 409, payload: { error: { code: "REQUEST_LIFECYCLE_NOT_ENABLED" } } }));
  mount(current); await screen.findByRole("button", { name: "Изменить тему обращения" });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Приоритет задачи" }), { key: "Enter" });
  fireEvent.keyDown(screen.getByRole("option", { name: /^Срочно$/ }), { key: "Enter" });
  await screen.findByRole("button", { name: "Обновить карточку" });
  expect(screen.queryByText("СРОЧНО")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Приоритет задачи" })).toHaveTextContent("Не срочно");
  expect(screen.queryByText("Изменение не сохранено")).not.toBeInTheDocument();
  expect(api.patch).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Обновить карточку" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Обновить карточку" })).not.toBeInTheDocument());
  expect(api.patch).toHaveBeenCalledOnce();
});


it("shows only the confirmed description edit time, independent of general card updates", async () => {
  const editedAt = "2026-10-27T09:15:00.000Z";
  mount({ ...task, descriptionEditedAt: editedAt, updatedAt: "2026-10-28T12:00:00.000Z" });
  const marker = screen.getByText(/^Изменено /);
  expect(marker.tagName).toBe("TIME"); expect(marker).toHaveAttribute("datetime", editedAt);
  expect(marker).toHaveAttribute("title", "Описание изменено после отправки обращения");
});

it.each([
  { ...task, updatedAt: "2026-10-28T12:00:00.000Z" },
  { ...task, descriptionEditedAt: "invalid" },
  { ...task, request: { state: "DRAFT", executorId: null }, descriptionEditedAt: "2026-10-27T09:15:00.000Z" },
])("does not invent an edit badge from updatedAt, invalid history or a draft %#", async current => {
  mount(current); expect(screen.queryByText(/^Изменено /)).not.toBeInTheDocument();
});

it("shows the author's correction after a colleague answer only after confirmed task recovery", async () => {
  let committed = false; const editedAt = "2026-10-27T09:15:00.000Z";
  const current = { ...task, request: { state: "IN_PROGRESS", executorId: "executor" } };
  api.read.mockImplementation(async (path: string) => path.endsWith("/lifecycle")
    ? { ...snapshot, state: "IN_PROGRESS", executorId: "executor", version: committed ? 8 : 7 }
    : { ...current, version: 8, description: "Исправленный текст", descriptionEditedAt: editedAt });
  api.post.mockImplementation(async () => { committed = true; return { taskId: "task", projectId: "project", version: 8, changed: true, replayed: false }; });
  mount(current); await screen.findByRole("button", { name: "Изменить описание" });
  expect(screen.queryByText(/^Изменено /)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Изменить описание" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Описание проверки прав" }), { target: { value: "Исправленный текст" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить описание" }));
  expect(await screen.findByText(/^Изменено /)).toHaveAttribute("datetime", editedAt);
  expect(api.post.mock.calls[0][1]).toMatchObject({ action: "edit_description", expectedVersion: 7 });
});

it("does not show a successful edit marker for a rejected description save", async () => {
  api.post.mockRejectedValue(Object.assign(new Error("conflict"), { status: 409, payload: { error: { code: "STALE_TASK_VERSION" } } }));
  mount(); await screen.findByRole("button", { name: "Изменить описание" });
  fireEvent.click(screen.getByRole("button", { name: "Изменить описание" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Описание проверки прав" }), { target: { value: "Не сохранено" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить описание" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
  await screen.findByRole("button", { name: "Обновить карточку" });
  expect(screen.queryByText(/^Изменено /)).not.toBeInTheDocument();
});
