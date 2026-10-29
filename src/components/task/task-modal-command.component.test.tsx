import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";
import type { TaskSaveCallbacks } from "./TaskDetailPanel";
const mocks = vi.hoisted(() => ({ patch: vi.fn(), post: vi.fn(), get: vi.fn(), back: vi.fn(), push: vi.fn(), success: vi.fn(), failure: vi.fn(), session: { status: "authenticated", data: { user: { id: "actor" } } }, mounted: 0 }));
vi.mock("@/lib/api", () => ({ apiPatch: mocks.patch, apiPost: mocks.post, apiFetch: (...args: unknown[]) =>
  args.length === 1 && String(args[0]).endsWith("/lifecycle")
    ? Promise.resolve({ taskId: "task-one", projectId: "project-one", version: 7, marked: false, deleted: false,
      permissions: { canEditFields: true, canEditDescription: true, canSetDeadline: false, canUseLegacyAssignees: false } })
    : mocks.get(...args) }));
vi.mock("next-auth/react", () => ({ useSession: () => mocks.session }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ back: mocks.back, push: mocks.push }) }));
vi.mock("@/hooks/useTaskDetailRealtime", () => ({ useTaskDetailRealtime: () => {} }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("./TaskDetailPanel", () => ({ TaskDetailPanel: ({ task, onSave, scalarSaveBlocked, saveStatus, onClose, onDelete }: { task: TaskType; onSave: (id: string, data: import("@/lib/task-scalar-transport").ModalTaskSave, callbacks?: TaskSaveCallbacks) => void; scalarSaveBlocked: boolean; saveStatus: React.ReactNode; onClose: () => void; onDelete: (id: string) => void }) => <div>
  {saveStatus}<p>Текущие данные: {task.title} · {task.version}</p><p>Блокировка: {String(scalarSaveBlocked)}</p>
  <button onClick={() => onSave(task.id, { title: " Новое название " }, { onSuccess: mocks.success, onError: mocks.failure })}>Название</button>
  <button onClick={() => onSave(task.id, { title: "STALE_TITLE", description: " Описание " }, { onSuccess: mocks.success, onError: mocks.failure })}>Описание</button>
  <button onClick={() => onSave(task.id, { title: "STALE_TITLE", priority: "LOW" })}>Приоритет</button>
  <button onClick={() => onSave(task.id, { title: "STALE_TITLE", deadline: new Date("2026-10-25T12:00:00Z") })}>Дедлайн</button>
  <button onClick={() => onSave(task.id, { title: "STALE_TITLE", columnId: "column-next", expectedVersion: task.version })}>Перенос</button>
  <button onClick={onClose}>Закрыть карточку</button>
  <button onClick={() => onDelete(task.id)}>Удалить карточку</button>
</div> }));
import { TaskModalPage } from "@/app/(dashboard)/projects/[id]/board/@modal/(..)tasks/[taskId]/TaskModalPage";
import { TaskDetailPage } from "@/app/(dashboard)/projects/[id]/tasks/[taskId]/TaskDetailPage";
let Consumer = TaskModalPage;
const task: TaskType = { id: "task-one", projectId: "project-one", title: "Исходное", description: "", priority: "HIGH", columnId: "column-one", position: 10, version: 7 };
function error(status: number) { return Object.assign(new Error("PRIVATE_ERROR"), { status }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const clients: QueryClient[] = [];
function mount(initial = task) { const client = new QueryClient(); clients.push(client); const tree = (value: TaskType) => <QueryClientProvider client={client}><Consumer projectId={value.projectId} taskId={value.id} task={value} /></QueryClientProvider>; const view = render(tree(initial)); return { ...view, client, rerenderTask: (value: TaskType) => view.rerender(tree(value)) }; }
beforeEach(() => { mocks.patch.mockReset(); mocks.post.mockReset(); mocks.get.mockReset(); mocks.back.mockReset(); mocks.success.mockReset(); mocks.failure.mockReset(); mocks.session.status = "authenticated"; mocks.session.data.user.id = "actor"; let sequence = 0; vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` }); const ack = { taskId: task.id, projectId: task.projectId, version: 8, changed: true, replayed: false }; mocks.patch.mockResolvedValue(ack); mocks.post.mockResolvedValue(ack); mocks.get.mockImplementation(async (path: string) => path.endsWith("/lifecycle") ? { taskId: task.id, projectId: task.projectId, marked: false, deleted: false } : { ...task, title: "Актуальное", version: 8 }); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });
describe.each(["modal", "standalone"])("%s scalar command consumer", kind => {
  beforeEach(() => { Consumer = kind === "modal" ? TaskModalPage : TaskDetailPage; mocks.push.mockReset(); });
  it("saves marked description through the canonical POST with exact original version/UUID and no incidental title", async () => {
    mocks.get.mockImplementation(async (path: string) => path.endsWith("/lifecycle") ? { taskId: task.id, projectId: task.projectId, marked: true, deleted: false, version: 99 } : { ...task, version: 8 });
    mount(); fireEvent.click(screen.getByText("Описание")); await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce());
    expect(mocks.post).toHaveBeenCalledOnce(); expect(mocks.patch).not.toHaveBeenCalled();
    const [path, body, telemetry] = mocks.post.mock.calls[0];
    expect(path).toBe("/api/tasks/task-one"); expect(body).toEqual({ action: "edit_description", description: "Описание", expectedVersion: 7, operationId: expect.any(String) });
    expect(telemetry).toEqual({ actionId: expect.any(String), operationId: body.operationId });
    expect(mocks.get.mock.calls).toEqual([
      [path + "/lifecycle", { method: "GET", cache: "no-store" }, { actionId: telemetry.actionId }],
      ["/api/tasks/task-one?view=details", { method: "GET", cache: "no-store" }, { actionId: telemetry.actionId }],
    ]);
  });
  it("keeps the exact marked description intent on an unknown POST retry and rechecks dispatch", async () => {
    mocks.get.mockImplementation(async (path: string) => path.endsWith("/lifecycle") ? { taskId: task.id, projectId: task.projectId, marked: true, deleted: false, version: 99 } : { ...task, version: 8 });
    mocks.post.mockRejectedValueOnce(new TypeError("PRIVATE")); const view = mount(); fireEvent.click(screen.getByText("Описание"));
    const retry = await screen.findByRole("button", { name: "Повторить сохранение" });
    view.rerenderTask({ ...task, version: 90, description: "new server snapshot" }); fireEvent.click(retry);
    await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce());
    expect(mocks.post).toHaveBeenCalledTimes(2); expect(mocks.post.mock.calls[0]).toEqual(mocks.post.mock.calls[1]); expect(mocks.post.mock.calls[1][1]).toMatchObject({ expectedVersion: 7, description: "Описание" });
    expect(mocks.get.mock.calls.filter(([path]) => path.endsWith("/lifecycle"))).toHaveLength(2); expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("requires fresh read after marked description conflict and never retries the rejected POST automatically", async () => {
    mocks.get.mockImplementation(async (path: string) => path.endsWith("/lifecycle") ? { taskId: task.id, projectId: task.projectId, marked: true, deleted: false } : { ...task, version: 12 });
    mocks.post.mockRejectedValueOnce(error(409)); mount(); fireEvent.click(screen.getByText("Описание"));
    fireEvent.click(await screen.findByRole("button", { name: "Обновить карточку" })); await screen.findByText("Текущие данные: Исходное · 12");
    expect(mocks.post).toHaveBeenCalledOnce(); expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.failure).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Описание")); await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1][1]).toMatchObject({ expectedVersion: 12 }); expect(mocks.post.mock.calls[1][1].operationId).not.toBe(mocks.post.mock.calls[0][1].operationId); expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("does not send either mutation after lifecycle lookup denial", async () => {
    mocks.get.mockRejectedValueOnce(error(403)); mount(); fireEvent.click(screen.getByText("Описание"));
    await screen.findByText("Карточка недоступна или права изменились."); expect(mocks.patch).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled(); expect(screen.queryByText(/PRIVATE/)).toBeNull();
  });
  it("requires explicit fresh read for malformed lifecycle metadata without sending or acknowledging a mutation", async () => {
    mocks.get.mockImplementation(async (path: string) => path.endsWith("/lifecycle") ? { taskId: task.id, projectId: task.projectId, marked: "true", deleted: false } : { ...task, version: 9 });
    mount(); fireEvent.click(screen.getByText("Описание"));
    fireEvent.click(await screen.findByRole("button", { name: "Обновить карточку" })); await screen.findByText("Текущие данные: Исходное · 9");
    expect(mocks.patch).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.failure).toHaveBeenCalledOnce(); expect(mocks.get).toHaveBeenCalledTimes(2);
  });
  it("rejects first hydration account mismatch against the authoritative server actor", () => { const client = new QueryClient(); clients.push(client); render(<QueryClientProvider client={client}><Consumer task={task} taskId={task.id} projectId={task.projectId} initialActorId="server-other" /></QueryClientProvider>); expect(screen.getByText(/Карточка скрыта до обновления страницы/)).toBeTruthy(); expect(screen.queryByText(/Текущие данные/)).toBeNull(); expect(mocks.patch).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled(); });
  it("preserves the consumer's close destination", () => { mount(); fireEvent.click(screen.getByText("Закрыть карточку")); if (kind === "modal") expect(mocks.back).toHaveBeenCalledOnce(); else expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/projects/project-one/board"); });
  it.each([["Название", { title: "Новое название" }], ["Описание", { description: "Описание" }], ["Приоритет", { priority: "LOW" }], ["Дедлайн", { deadline: "2026-10-25T12:00:00.000Z" }]])("sends only the %s field intent, then reads authoritative details with correlation", async (label, changes) => { mount(); fireEvent.click(screen.getByText(label as string)); await screen.findByText("Текущие данные: Актуальное · 8"); expect(mocks.patch).toHaveBeenCalledOnce(); const [url, body, telemetry] = mocks.patch.mock.calls[0]; expect(url).toBe("/api/tasks/task-one"); expect(body).toEqual({ expectedVersion: 7, changes, operationId: expect.any(String) }); expect(telemetry).toEqual({ actionId: expect.any(String), operationId: body.operationId }); expect(telemetry.actionId).not.toBe(body.operationId); if (label === "Описание") expect(mocks.get.mock.calls[0]).toEqual(["/api/tasks/task-one/lifecycle", { method: "GET", cache: "no-store" }, { actionId: telemetry.actionId }]); expect(mocks.get).toHaveBeenCalledTimes(label === "Описание" ? 2 : 1); expect(mocks.get.mock.calls[label === "Описание" ? 1 : 0]).toEqual(["/api/tasks/task-one?view=details", { method: "GET", cache: "no-store" }, { actionId: telemetry.actionId }]); expect(mocks.post).not.toHaveBeenCalled(); });
  it("blocks pending duplicate/scalar/move/close attempts and acknowledges original callback after read", async () => { const pending = deferred<unknown>(); mocks.patch.mockReturnValue(pending.promise); mount(); fireEvent.click(screen.getByText("Название")); fireEvent.click(screen.getByText("Описание")); fireEvent.click(screen.getByText("Перенос")); fireEvent.click(screen.getByText("Закрыть карточку")); expect(mocks.patch).toHaveBeenCalledOnce(); expect(mocks.back).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled(); await act(async () => { pending.resolve({ taskId: task.id, projectId: task.projectId, version: 8 }); }); await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce()); expect(mocks.failure).not.toHaveBeenCalled(); });
  it.each(["network", "5xx"])("exact %s retry uses identical UUID/body/action despite route snapshot advancement", async kind => { mocks.patch.mockRejectedValueOnce(kind === "network" ? new TypeError("private") : error(503)).mockResolvedValueOnce({ taskId: task.id, projectId: task.projectId, version: 8, replayed: true }); const view = mount(); fireEvent.click(screen.getByText("Название")); const retry = await screen.findByRole("button", { name: "Повторить сохранение" }); await waitFor(() => expect(retry.closest("[role=alert]")).toHaveFocus()); view.rerenderTask({ ...task, title: "Коллега", version: 9 }); fireEvent.click(screen.getByText("Приоритет")); fireEvent.click(retry); await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2)); expect(mocks.patch.mock.calls[0]).toEqual(mocks.patch.mock.calls[1]); await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce()); expect(screen.queryByText(/PRIVATE/)).toBeNull(); });
  it("409 read recovery does not retry or acknowledge the rejected command, including failed recovery read", async () => { mocks.patch.mockRejectedValueOnce(error(409)); mocks.get.mockRejectedValueOnce(error(503)).mockResolvedValueOnce({ ...task, title: "Коллега", version: 9 }); mount(); fireEvent.click(screen.getByText("Название")); fireEvent.click(await screen.findByRole("button", { name: "Обновить карточку" })); fireEvent.click(await screen.findByRole("button", { name: "Обновить карточку" })); await screen.findByText("Текущие данные: Коллега · 9"); expect(mocks.patch).toHaveBeenCalledOnce(); expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.failure).toHaveBeenCalledOnce(); });
  it("committed ACK plus failed read can only retry GET, preserving original callback", async () => { mocks.get.mockRejectedValueOnce(error(503)).mockResolvedValueOnce({ ...task, title: "Сохранено", version: 8 }); mount(); fireEvent.click(screen.getByText("Название")); const read = await screen.findByRole("button", { name: "Обновить карточку" }); expect(mocks.success).not.toHaveBeenCalled(); fireEvent.click(screen.getByText("Название")); fireEvent.click(read); await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce()); expect(mocks.patch).toHaveBeenCalledOnce(); expect(mocks.get).toHaveBeenCalledTimes(2); });
  it("separates legacy canonical column move from scalar command and excludes incidental title", async () => { mount(); fireEvent.click(screen.getByText("Перенос")); await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce()); expect(mocks.patch.mock.calls[0][1]).toEqual({ columnId: "column-next", expectedVersion: 7 }); expect(mocks.patch.mock.calls[0][2]).toEqual({ actionId: expect.any(String) }); });
  it.each([401, 403, 404])("denied %s clears visible task instead of showing raw errors", async code => { mocks.patch.mockRejectedValueOnce(error(code)); mount(); fireEvent.click(screen.getByText("Название")); await screen.findByText("Карточка недоступна или права изменились."); expect(screen.queryByText(/Текущие данные/)).toBeNull(); expect(screen.queryByText(/PRIVATE_ERROR/)).toBeNull(); });
  it("new task identity ignores late ACK and cannot apply old callbacks/details", async () => { const pending = deferred<unknown>(); mocks.patch.mockReturnValue(pending.promise); const view = mount(); fireEvent.click(screen.getByText("Название")); view.rerenderTask({ ...task, id: "task-two", title: "Другая задача" }); await act(async () => { pending.resolve({ taskId: task.id, projectId: task.projectId, version: 8 }); }); expect(screen.getByText("Текущие данные: Другая задача · 7")).toBeTruthy(); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.failure).not.toHaveBeenCalled(); });
  it("account switch hides the previous server task and ignores its late ACK until full reload", async () => { const pending = deferred<unknown>(); mocks.patch.mockReturnValue(pending.promise); const view = mount(); fireEvent.click(screen.getByText("Название")); mocks.session.data.user.id = "other"; view.rerenderTask(task); await screen.findByText(/Карточка скрыта до обновления страницы/); await act(async () => { pending.resolve({ taskId: task.id, projectId: task.projectId, version: 8 }); }); expect(screen.queryByText(/Текущие данные/)).toBeNull(); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled(); });
  it("requires a fresh read when initial version is missing; never falls back to a flat scalar PATCH", async () => { mount({ ...task, version: undefined }); fireEvent.click(screen.getByText("Название")); await screen.findByRole("button", { name: "Обновить карточку" }); expect(mocks.patch).not.toHaveBeenCalled(); });
  it("requires explicit recovery after409, then creates a fresh UUID/version for a new intent", async () => {
    mocks.patch.mockRejectedValueOnce(error(409)); mocks.get.mockResolvedValue({ ...task, version: 12 }); mount();
    fireEvent.click(screen.getByText("Название")); await screen.findByRole("button", { name: "Обновить карточку" });
    fireEvent.click(screen.getByText("Приоритет")); fireEvent.click(screen.getByText("Закрыть карточку"));
    expect(mocks.patch).toHaveBeenCalledOnce(); expect(mocks.push).not.toHaveBeenCalled(); expect(mocks.back).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Обновить карточку" })); await screen.findByText("Текущие данные: Исходное · 12");
    fireEvent.click(screen.getByText("Приоритет")); await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    expect(mocks.patch.mock.calls[1][1]).toMatchObject({ expectedVersion: 12, changes: { priority: "LOW" } });
    expect(mocks.patch.mock.calls[1][1].operationId).not.toBe(mocks.patch.mock.calls[0][1].operationId);
  });
  it("ignores a late authoritative read after unmount, including callbacks and cache writes", async () => {
    const pending = deferred<TaskType>(); mocks.get.mockReturnValue(pending.promise); const view = mount();
    view.client.setQueryData(["task", task.id], { sentinel: true }); fireEvent.click(screen.getByText("Название"));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce()); view.unmount();
    await act(async () => { pending.resolve({ ...task, title: "Late", version: 8 }); });
    expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.failure).not.toHaveBeenCalled();
    expect(view.client.getQueryData(["task", task.id])).toEqual({ sentinel: true });
  });
  it("synchronously blocks duplicate deletion, saving and closing; ignores a late delete after unmount", async () => {
    const pending = deferred<Response>(); const fetch = vi.fn(() => pending.promise); vi.stubGlobal("fetch", fetch); vi.stubGlobal("confirm", vi.fn(() => true));
    const view = mount(); view.client.setQueryData(["tasks", task.projectId], [{ sentinel: true }]);
    fireEvent.click(screen.getByText("Удалить карточку")); fireEvent.click(screen.getByText("Удалить карточку"));
    fireEvent.click(screen.getByText("Название")); fireEvent.click(screen.getByText("Закрыть карточку"));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce()); expect(mocks.patch).not.toHaveBeenCalled(); expect(mocks.back).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
    view.unmount(); await act(async () => { pending.resolve(new Response(null, { status: 204 })); });
    expect(view.client.getQueryState(["tasks", task.projectId])?.isInvalidated).toBe(false);
  });
});
