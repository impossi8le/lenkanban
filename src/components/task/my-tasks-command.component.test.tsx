import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";
import type { ModalTaskSave } from "@/lib/task-scalar-transport";

const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), replace: vi.fn(), session: { status: "authenticated", data: { user: { id: "actor-A" } } } }));
// Keep initial permission projection separate from this suite's command/detail
// transport fault injections and exact-read assertions.
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => args.length === 1 && String(args[0]).endsWith("/lifecycle")
  ? Promise.resolve({ taskId: "task-A", projectId: "project-A", version: 7, marked: false, deleted: false,
    permissions: { canEditFields: true, canEditDescription: true, canSetDeadline: false, canUseLegacyAssignees: false } })
  : mocks.get(...args), apiPatch: mocks.patch }));
vi.mock("next-auth/react", () => ({ useSession: () => mocks.session }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/hooks/useTaskDetailRealtime", () => ({ useTaskDetailRealtime: () => {} }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("./TaskDetailPanel", () => ({ TaskDetailPanel: ({ task, onSave, onClose, onDelete, scalarSaveBlocked, saveStatus }: {
  task: TaskType; onSave: (id: string, data: ModalTaskSave) => void; onClose: () => void;
  onDelete: (id: string) => void; scalarSaveBlocked: boolean; saveStatus: React.ReactNode;
}) => <section role="dialog" aria-label="Test editable task">
  {saveStatus}<p>Full task: {task.title} / {task.version}</p><p>Blocked: {String(scalarSaveBlocked)}</p>
  <button onClick={() => onSave(task.id, { title: "Updated" })}>Save intent</button>
  <button onClick={() => onSave(task.id, { title: "Ignored stale title", priority: "LOW" })}>Priority intent</button>
  <button onClick={onClose}>Close editor</button><button onClick={() => onDelete(task.id)}>Delete task</button>
</section> }));
import MyTasksPage from "@/app/(dashboard)/my-tasks/page";

const listPath = "/api/tasks?assignedToMe=true&limit=500", detailsPath = "/api/tasks/task-A?view=details";
// Deliberately no version, description, columnId or collection fields in this row.
const row = { id: "task-A", title: "List row only", project: { id: "project", name: "Board" }, priority: "HIGH", status: "TODO", createdAt: "2026-10-20T00:00:00Z", deadline: null };
const detail: TaskType = { id: "task-A", projectId: "project", title: "Authorized details", version: 7, priority: "HIGH", columnId: "column", position: 1024, description: "Description" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function failure(status = 503) { return Object.assign(Error("synthetic-private-task-description"), { status }); }
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  const tree = () => <QueryClientProvider client={client}><MyTasksPage /></QueryClientProvider>;
  const view = render(tree()); return { ...view, client, rerenderPage: () => view.rerender(tree()) };
}
async function open() { fireEvent.click(await screen.findByText("List row only")); }
function detailReads() { return mocks.get.mock.calls.filter(([url]) => url === detailsPath); }
beforeEach(() => {
  mocks.get.mockReset(); mocks.patch.mockReset(); mocks.replace.mockReset(); mocks.session.status = "authenticated"; mocks.session.data.user.id = "actor-A";
  let next = 0; vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}` });
  vi.stubGlobal("confirm", vi.fn(() => true)); vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))));
  mocks.get.mockImplementation(async url => url === listPath ? [row] : { ...detail, title: mocks.patch.mock.calls.length ? "Server current" : detail.title, version: mocks.patch.mock.calls.length ? 8 : 7 });
  mocks.patch.mockResolvedValue({ taskId: detail.id, projectId: detail.projectId, version: 8, changed: true, replayed: false });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); focusManager.setFocused(undefined); vi.unstubAllGlobals(); });

describe("actor-bound MyTasks uses the common scalar command controller", () => {
  it.each(["loading", "unauthenticated"])("does not read or display cached rows before authenticated session (%s)", status => {
    mocks.session.status = status; const view = mount(); act(() => { view.client.setQueryData(["my-tasks", "actor-A", "assigned", false], [row]); });
    expect(mocks.get).not.toHaveBeenCalled(); expect(screen.queryByText("List row only")).toBeNull(); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("requires full authorized details before editing an intentionally incomplete row", async () => {
    const read = deferred<TaskType>(); mocks.get.mockImplementation(url => url === listPath ? Promise.resolve([row]) : read.promise);
    mount(); await open(); await screen.findByText("Загрузка актуальной карточки…");
    expect(screen.queryByText(/Full task:/)).toBeNull(); expect(mocks.patch).not.toHaveBeenCalled();
    expect(detailReads()[0]).toEqual([detailsPath, expect.objectContaining({ method: "GET", cache: "no-store", signal: expect.any(AbortSignal) })]);
    await act(async () => read.resolve(detail)); await screen.findByText("Full task: Authorized details / 7");
    fireEvent.click(screen.getByText("Save intent")); await screen.findByText("Full task: Authorized details / 7");
    expect(mocks.patch.mock.calls[0][1]).toMatchObject({ expectedVersion: 7, changes: { title: "Updated" } });
  });
  it.each([{ id: "other" }, { projectId: "other" }, { version: undefined }, { version: -1 }, { version: 2147483648 }])("rejects mismatched or versionless full read %# without assuming a list version", async changes => {
    mocks.get.mockImplementation(async url => url === listPath ? [row] : { ...detail, ...changes }); mount(); await open();
    await screen.findByText("Не удалось загрузить актуальную карточку задачи."); expect(screen.queryByText(/Full task:/)).toBeNull(); expect(mocks.patch).not.toHaveBeenCalled();
  });
  it.each(["network", "5xx"])("retains exact %s command/correlation across duplicates and background list refresh", async kind => {
    mocks.patch.mockRejectedValueOnce(kind === "network" ? new TypeError("private") : failure()); const view = mount(); await open();
    await screen.findByText("Full task: Authorized details / 7"); fireEvent.click(screen.getByText("Save intent"));
    const retry = await screen.findByRole("button", { name: "Повторить сохранение" });
    fireEvent.click(screen.getByText("Priority intent")); fireEvent.click(screen.getByText("Close editor")); fireEvent.click(screen.getByText("Delete task"));
    mocks.get.mockImplementation(async url => url === listPath ? [{ ...row, title: "List refreshed" }, { ...row, id: "task-B", title: "Other task" }] : { ...detail, title: "Server current", version: 8 });
    await act(async () => { await view.client.refetchQueries({ queryKey: ["my-tasks", "actor-A", "assigned", false], exact: true }); });
    fireEvent.click(await screen.findByText("Other task"));
    expect(mocks.get.mock.calls.some(([url]) => url === "/api/tasks/task-B?view=details")).toBe(false);
    await act(async () => { focusManager.setFocused(true); });
    expect(screen.getByRole("button", { name: "Повторить сохранение" })).toBe(retry); expect(detailReads()).toHaveLength(1); expect(mocks.patch).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(retry); await screen.findByText("Full task: Server current / 8");
    expect(mocks.patch.mock.calls[1]).toEqual(mocks.patch.mock.calls[0]);
    const [url, body, telemetry] = mocks.patch.mock.calls[0]; expect(url).toBe("/api/tasks/task-A"); expect(body).toEqual({ operationId: expect.any(String), expectedVersion: 7, changes: { title: "Updated" } });
    expect(telemetry).toEqual({ actionId: expect.any(String), operationId: body.operationId }); expect(telemetry.actionId).not.toBe(body.operationId);
  });
  it("409 requires explicit current read and new intent/UUID at the newly read version", async () => {
    mocks.patch.mockRejectedValueOnce(failure(409)); const view = mount(); await open(); await screen.findByText("Full task: Authorized details / 7");
    fireEvent.click(screen.getByText("Save intent")); await screen.findByRole("button", { name: "Обновить карточку" });
    fireEvent.click(screen.getByText("Priority intent")); fireEvent.click(screen.getByText("Close editor")); expect(mocks.patch).toHaveBeenCalledOnce(); expect(detailReads()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Обновить карточку" })); await screen.findByText("Full task: Server current / 8");
    view.client.setQueryData(["my-tasks", "actor-B"], [{ ...row, title: "Other account" }]);
    fireEvent.click(screen.getByText("Priority intent")); await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    expect(mocks.patch.mock.calls[1][1]).toMatchObject({ expectedVersion: 8, changes: { priority: "LOW" } });
    expect(mocks.patch.mock.calls[1][1].operationId).not.toBe(mocks.patch.mock.calls[0][1].operationId);
    expect(view.client.getQueryState(["my-tasks", "actor-B"])?.isInvalidated).toBe(false);
  });
  it("ACK followed by read failure retries only GET and keeps selection blocked", async () => {
    let reads = 0;
    mocks.get.mockImplementation(async url => {
      if (url === listPath) return [row];
      // Count only the canonical detail transport being fault-injected. Board
      // change summaries are independent reads and must not consume this fault.
      if (url !== detailsPath) return { actorId: "actor-A", byTask: {} };
      if (++reads === 2) throw failure();
      return reads === 1 ? detail : { ...detail, title: "Recovered", version: 8 };
    });
    mount(); await open(); await screen.findByText("Full task: Authorized details / 7"); fireEvent.click(screen.getByText("Save intent"));
    const retry = await screen.findByRole("button", { name: "Обновить карточку" }); fireEvent.click(screen.getByText("Close editor")); fireEvent.click(screen.getByText("Priority intent"));
    expect(screen.getByText("Full task: Authorized details / 7")).toBeTruthy(); fireEvent.click(retry); await screen.findByText("Full task: Recovered / 8");
    expect(mocks.patch).toHaveBeenCalledOnce(); expect(detailReads()).toHaveLength(3);
  });
  it("actor change cancels pending initial details and removes previous account query data", async () => {
    const old = deferred<TaskType>(); mocks.get.mockImplementation(url => url === listPath ? Promise.resolve([row]) : old.promise);
    const view = mount(); await open(); await screen.findByText("Загрузка актуальной карточки…"); const signal = detailReads()[0][1].signal as AbortSignal;
    mocks.session.data.user.id = "actor-B"; view.rerenderPage(); await screen.findByText("List row only");
    await act(async () => old.resolve(detail)); expect(signal.aborted).toBe(true); expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.client.getQueryData(["my-tasks", "actor-A", "assigned", false])).toBeUndefined(); expect(view.client.getQueryCache().findAll({ queryKey: ["my-task-details", "actor-A"] })).toHaveLength(0);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("actor change ignores the previous account's late PATCH completion and never starts its GET", async () => {
    const pending = deferred<unknown>(); mocks.patch.mockReturnValue(pending.promise); const view = mount(); await open(); await screen.findByText("Full task: Authorized details / 7");
    fireEvent.click(screen.getByText("Save intent")); mocks.session.data.user.id = "actor-B"; view.rerenderPage(); await screen.findByText("List row only");
    await act(async () => pending.resolve({ taskId: detail.id, projectId: detail.projectId, version: 8 }));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(detailReads()).toHaveLength(1); expect(view.client.getQueryData(["my-tasks", "actor-A", "assigned", false])).toBeUndefined();
  });
  it("close/reopen of the same task always requires another full read despite cached data", async () => {
    const view = mount(); await open(); await screen.findByText("Full task: Authorized details / 7"); fireEvent.click(screen.getByText("Save intent")); await screen.findByText("Full task: Server current / 8");
    fireEvent.click(screen.getByText("Close editor")); expect(screen.queryByRole("dialog")).toBeNull();
    const next = deferred<TaskType>(); mocks.get.mockImplementation(url => url === listPath ? Promise.resolve([row]) : next.promise);
    await open(); await screen.findByText("Загрузка актуальной карточки…"); expect(screen.queryByText(/Full task:/)).toBeNull(); expect(detailReads()).toHaveLength(3);
    await act(async () => next.resolve({ ...detail, title: "Newly authorized", version: 12 })); await screen.findByText("Full task: Newly authorized / 12");
    expect(view.client.getQueryCache().findAll({ queryKey: ["my-task-details", "actor-A"] })).toHaveLength(1);
  });
  it("denied initial details uses fixed text and a close action without exposing the list as editable", async () => {
    mocks.get.mockImplementation(async url => { if (url === listPath) return [row]; throw failure(403); }); mount(); await open();
    await screen.findByText("Карточка недоступна или права изменились."); expect(screen.queryByText(/Full task:/)).toBeNull(); expect(screen.queryByText(/synthetic-private/)).toBeNull();
    await waitFor(() => expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть загрузку карточки" })); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("closing an initial load prevents its late response from attaching to a later opening", async () => {
    const first = deferred<TaskType>(); mocks.get.mockImplementation(url => url === listPath ? Promise.resolve([row]) : first.promise); mount(); await open();
    fireEvent.click(await screen.findByRole("button", { name: "Закрыть загрузку карточки" }));
    mocks.get.mockImplementation(async url => url === listPath ? [row] : { ...detail, title: "Second opening", version: 10 }); await open(); await screen.findByText("Full task: Second opening / 10");
    await act(async () => first.resolve({ ...detail, title: "Late first opening" }));
    expect(screen.queryByText(/Late first opening/)).toBeNull(); expect(screen.getByText("Full task: Second opening / 10")).toBeTruthy();
  });
  it("retains an unresolved command when an empty background list subsequently fails", async () => {
    mocks.patch.mockRejectedValueOnce(failure()); const view = mount(); await open(); await screen.findByText("Full task: Authorized details / 7");
    await act(async () => { view.client.setQueryData(["my-tasks", "actor-A", "assigned", false], []); });
    fireEvent.click(screen.getByText("Save intent")); const retry = await screen.findByRole("button", { name: "Повторить сохранение" });
    mocks.get.mockImplementation(async url => { if (url === listPath) throw failure(); return { ...detail, title: "Server current", version: 8 }; });
    await act(async () => { await view.client.refetchQueries({ queryKey: ["my-tasks", "actor-A", "assigned", false], exact: true }); });
    expect(screen.getByRole("button", { name: "Повторить сохранение" })).toBe(retry);
    fireEvent.click(retry); await screen.findByText("Full task: Server current / 8"); expect(mocks.patch.mock.calls[1]).toEqual(mocks.patch.mock.calls[0]);
  });
  it("keeps denied cached rows hidden across failed/loading retries until a successful authorized read", async () => {
    const pending = deferred<unknown>(); mocks.patch.mockReturnValue(pending.promise); const view = mount(); await open(); await screen.findByText("Full task: Authorized details / 7");
    fireEvent.click(screen.getByText("Save intent")); mocks.get.mockImplementation(async () => { throw failure(403); });
    await act(async () => { await view.client.refetchQueries({ queryKey: ["my-tasks", "actor-A", "assigned", false], exact: true }); });
    await screen.findByText("Список задач недоступен. Проверьте вход и права доступа."); expect(screen.queryByText("List row only")).toBeNull(); expect(screen.queryByText(/Full task:/)).toBeNull();
    mocks.get.mockImplementation(async () => { throw failure(); }); fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку задач" }));
    await waitFor(() => expect(view.client.isFetching()).toBe(0)); expect(screen.queryByText("List row only")).toBeNull();
    await act(async () => pending.resolve({ taskId: detail.id, projectId: detail.projectId, version: 8 })); expect(screen.queryByText(/Full task:/)).toBeNull();
    const reload = deferred<unknown>(); mocks.get.mockReturnValue(reload.promise); fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку задач" }));
    expect(screen.queryByText("List row only")).toBeNull(); await act(async () => reload.resolve([{ ...row, title: "Fresh authorized row" }]));
    await screen.findByText("Fresh authorized row"); expect(screen.queryByText("List row only")).toBeNull(); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("focuses and closes the initial loader with Escape without attaching its late response", async () => {
    const pending = deferred<TaskType>(); mocks.get.mockImplementation(url => url === listPath ? Promise.resolve([row]) : pending.promise); mount(); await open();
    const dialog = await screen.findByRole("dialog", { name: "Загрузка карточки задачи" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true)); fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); await act(async () => pending.resolve(detail)); expect(screen.queryByText(/Full task:/)).toBeNull();
  });
});
