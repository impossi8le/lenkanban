import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskModalPage } from "@/app/(dashboard)/projects/[id]/board/@modal/(..)tasks/[taskId]/TaskModalPage";
import { TaskDetailPage } from "@/app/(dashboard)/projects/[id]/tasks/[taskId]/TaskDetailPage";
import MyTasksPage from "@/app/(dashboard)/my-tasks/page";
import type { TaskType } from "@/components/kanban/Card";
import { TaskDetailPanel } from "./TaskDetailPanel";

// The shared column selector gates on the authenticated actor, so every consumer
// in this file needs a session, exactly like the neighbouring task-panel suites.
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "user-1", name: "User", email: "user@example.test", image: null } }, status: "authenticated" }),
}));
const realtime = vi.hoisted(() => ({ listeners: new Map<string, Set<(event: unknown) => void>>(), refresh: () => {} }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: () => realtime.refresh() }) }));
vi.mock("@/lib/socket-client", () => { const socket = {
  connected: false,
  on: (name: string, listener: (event: unknown) => void) => {
    const group = realtime.listeners.get(name) ?? new Set(); group.add(listener); realtime.listeners.set(name, group);
  },
  off: (name: string, listener: (event: unknown) => void) => realtime.listeners.get(name)?.delete(listener),
  emit: () => {},
}; return { getSocketInstance: () => socket }; });
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: "user-1" } } }) }));
vi.mock("./AssigneeSelector", () => ({ AssigneeSelector: () => null }));
vi.mock("./TagPicker", () => ({ TagPicker: () => null }));
vi.mock("./TaskChecklist", () => ({ TaskChecklist: () => null }));
vi.mock("./ActivityTimeline", () => ({ ActivityTimeline: () => null }));
vi.mock("./TaskAttachments", () => ({ TaskAttachments: () => null }));
vi.mock("@/components/templates/TemplateDialog", () => ({ TemplateDialog: () => null }));
vi.mock("@/components/ui/calendar", () => ({ Calendar: ({ onSelect }: { onSelect: (date: Date | undefined) => void }) => <>
  <button onClick={() => onSelect(new Date("2026-09-19T12:00:00Z"))}>Выбрать дату</button>
  <button onClick={() => onSelect(undefined)}>Очистить дату</button></> }));
// Editor boundary only: retain the real panel's description change/save logic.
vi.mock("next/dynamic", async () => {
  const { Calendar } = await import("@/components/ui/calendar");
  return { default: (loader: () => unknown) => loader.toString().includes("ui/calendar") ? Calendar : ({ content, onChange, onSave }: {
  content?: string; onChange?: (value: string) => void; onSave?: () => void;
}) => content === undefined ? null : <><textarea aria-label="Редактор описания" value={content} onChange={(e) => onChange?.(e.target.value)} />
  <button onClick={onSave}>Сохранить описание</button></> };
});

const initialTask: TaskType = { id: "task-1", title: "Исходное имя", description: "Исходное описание",
  projectId: "project-1", priority: "HIGH", status: "TODO", columnId: "todo", position: 1024,
  deadline: null, version: 7, assignees: [{ id: "assignment", user: { id: "user-1", name: "User", email: "user@example.invalid" } }], tags: [], attachments: [], checklistItems: [] };
const columns = [
  { id: "todo", name: "Входящие заявки", projectId: "project-1", position: 0, workflowKey: "TODO", status: "TODO" },
  { id: "waiting", name: "Ожидает деталей", projectId: "project-1", position: 1, workflowKey: "COLUMN_CUSTOM", status: "COLUMN_CUSTOM" },
];
const clients: QueryClient[] = [];
function titleEditor() {
  const edit = screen.queryByRole("button", { name: "Изменить тему обращения" });
  if (edit) fireEvent.click(edit);
  return screen.getByRole("textbox", { name: "Тема обращения" });
}

describe("optional scalar block on the shared panel", () => {
  it("cancels a queued title timer and blocks description saves without changing default consumer behavior", async () => {
    const onSave = vi.fn(); const props = { task: initialTask, onSave, onClose: vi.fn() }; const client = new QueryClient(); clients.push(client); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, data: columns }))); const view = render(<QueryClientProvider client={client}><TaskDetailPanel {...props} /></QueryClientProvider>); await settleInitialization();
    fireEvent.change(titleEditor(), { target: { value: "Черновик" } });
    view.rerender(<QueryClientProvider client={client}><TaskDetailPanel {...props} scalarSaveBlocked saveStatus={<div role="alert"><button>Проверить результат</button></div>} /></QueryClientProvider>);
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveAttribute("readonly"); fireEvent.click(screen.getByRole("button", { name: "Сохранить описание" }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); }); expect(onSave).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Проверить результат" }).closest('[role="dialog"]')).toBeTruthy();
  });
});
beforeEach(() => {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  vi.stubGlobal("localStorage", frame.contentWindow!.localStorage);
  localStorage.clear();
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); vi.unstubAllGlobals(); document.querySelectorAll("iframe").forEach(frame => frame.remove()); });

// The existing panel has a 100ms initialization guard; finish it before editing.
async function settleInitialization() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); }); }
async function choose(index: number, option: string) {
  const panel = screen.getByRole("dialog", { name: "Детали обращения" });
  fireEvent.keyDown(within(panel).getAllByRole("combobox")[index], { key: "Enter" });
  fireEvent.keyDown(await screen.findByRole("option", { name: option }), { key: "Enter" });
}

describe.each(["modal", "detail", "my-tasks"] as const)("%s canonical task baseline", (kind) => {
  async function mount(deferWrite = false) {
    let canonical = { ...initialTask };
    let finishWrite: ((ok?: boolean) => void) | undefined;
    let failureCode: number | undefined;
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/tasks/task-1/lifecycle" && (!options?.method || options.method === "GET")) return Response.json({ success: true, data: { taskId: canonical.id, projectId: canonical.projectId, version: canonical.version, marked: false, deleted: false,
        permissions: { canEditFields: true, canEditDescription: true, canSetDeadline: true, canUseLegacyAssignees: false } } });
      if (options?.method === "PATCH") {
        const beforeWrite = canonical;
        const body = JSON.parse(String(options.body));
        writes.push(body);
        if (failureCode) { const status = failureCode; failureCode = undefined; canonical = { ...canonical, version: (canonical.version ?? 0) + 1, title: "Коллега изменил" }; return Response.json({ success: false, error: { message: "Synthetic conflict" } }, { status }); }
        const instrumented = !!body.changes;
        const updates = instrumented ? body.changes : body;
        // Match the server's column-derived workflow contract: a status-only
        // PATCH is invalid, and custom workflow values come from real columns.
        if (updates.status && !updates.columnId) return Response.json({ success: false,
          error: { message: "status requires columnId" } }, { status: 422 });
        const target = columns.find((column) => column.id === updates.columnId);
        if (updates.columnId && (!target || updates.expectedVersion !== canonical.version)) {
          return Response.json({ success: false, error: { message: "Invalid column/version" } }, { status: 409 });
        }
        canonical = { ...canonical, ...updates,
          ...(target ? { columnId: target.id, status: target.status, version: (canonical.version ?? 0) + 1 } : {}),
          title: updates.title === "Новое имя" ? "Новое имя · сервер" : updates.title ?? canonical.title };
        if (instrumented) canonical = { ...canonical, version: (canonical.version ?? 0) + 1 };
        const response = Response.json({ success: true, data: instrumented ? { taskId: canonical.id, projectId: canonical.projectId, version: canonical.version, changed: true, replayed: false } : canonical });
        return deferWrite ? new Promise<Response>((resolve) => { finishWrite = (ok = true) => {
          if (!ok) canonical = beforeWrite;
          resolve(ok ? response : Response.json({ success: false, error: { message: "Offline" } }, { status: 503 }));
        }; }) : response;
      }
      if (url === "/api/tasks/task-1?view=details") return Response.json({ success: true, data: canonical });
      if (url === "/api/tasks?assignedToMe=true&limit=500") return Response.json({ success: true, data: [{ ...canonical,
        createdAt: "2026-09-14T10:00:00Z", project: { id: "project-1", name: "Проект" } }] });
      if (url === "/api/projects/project-1/task-permissions") return Response.json({ success: true, data: { canChangeStatus: true } });
      if (url.endsWith("/columns")) return Response.json({ success: true, data: columns });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    clients.push(client);
    function tree(routeTask = initialTask) {
      return <QueryClientProvider client={client}>{kind === "modal"
        ? <TaskModalPage projectId={routeTask.projectId} taskId={routeTask.id} task={routeTask} /> : kind === "detail"
          ? <TaskDetailPage projectId={routeTask.projectId} taskId={routeTask.id} task={routeTask} /> : <MyTasksPage />}</QueryClientProvider>;
    }
    const view = render(tree());
    realtime.refresh = () => view.rerender(tree({ ...canonical }));
    if (kind === "my-tasks") { await userEvent.click(await screen.findByText("Исходное имя")); await screen.findByRole("textbox", { name: "Тема обращения" }); }
    await settleInitialization();
    return { writes, client, failNext: (code: number) => { failureCode = code; }, busy: () => Number(!!screen.queryByText("Сохранение изменений…") || !!screen.queryByText("Обновляем карточку…")), canonical: () => canonical, finishWrite: (ok = true) => finishWrite?.(ok), rerender: (routeTask: TaskType) => view.rerender(tree(routeTask)),
      remote: (event: string, updates: Partial<TaskType>, id = initialTask.id) => {
        canonical = { ...canonical, ...updates };
        const payload = event === "task:moved" ? { task: { id, columnId: canonical.columnId, version: canonical.version, status: canonical.status }, boardRevision: 1 } : { ...canonical, id };
        act(() => realtime.listeners.get(event)?.forEach(listener => listener(payload)));
      } };
  }

  it("shows title success only after the server confirms the write", async () => {
    const state = await mount(true);
    fireEvent.change(titleEditor(), { target: { value: "Новое имя" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить название" }));
    await waitFor(() => expect(state.busy()).toBe(1), { timeout: 2500 });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    expect(screen.getByRole("status", { name: "Сохранение названия" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Название сохранено")).not.toBeInTheDocument();
    await act(async () => state.finishWrite());
    await waitFor(() => expect(screen.getByLabelText("Название сохранено")).toBeInTheDocument());
  });

  it("409 recovery remount preserves local draft for explicit restoration and never auto-resubmits it", async () => {
    const state = await mount(); state.failNext(409);
    // Install the clock before the first edit: all debounce, recovery and
    // restoration timers belong to this clock, including unintended timers.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.change(titleEditor(), { target: { value: "Мой конфликтный текст" } });
      expect(state.writes).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Сохранить название" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      // Positive control: the explicit save executes on this clock.
      expect(state.writes).toHaveLength(1);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Обновить карточку" })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(120); });
      // Motion captured the real RAF/performance clock before fake timers were
      // installed. Poll actual visibility while retaining debounce timer ownership.
      await expect.poll(() => screen.getByText("Найден черновик")).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Коллега изменил");
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); }); expect(state.writes).toHaveLength(1);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Восстановить черновик" })); });
      expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Мой конфликтный текст");
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); }); expect(state.writes).toHaveLength(1);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Сохранить название" })); });
      expect(state.writes).toHaveLength(2);
      expect(state.writes[1]).toMatchObject({ expectedVersion: 8, changes: { title: "Мой конфликтный текст" } });
      expect(state.writes[1].operationId).not.toBe(state.writes[0].operationId);
    } finally { vi.useRealTimers(); }
  });

  it("keeps a failed title editable and retries only when requested", async () => {
    const state = await mount(true);
    fireEvent.change(titleEditor(), { target: { value: "Новое имя" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить название" }));
    await waitFor(() => expect(state.busy()).toBe(1), { timeout: 2500 });
    await act(async () => state.finishWrite(false));
      const retry = await screen.findByRole("button", { name: "Повторить сохранение" });
      expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveAttribute("readonly");
      expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Новое имя");
      expect(screen.queryByLabelText("Название сохранено")).not.toBeInTheDocument();
      await userEvent.click(retry); await waitFor(() => expect(state.writes).toHaveLength(2));
      expect(state.writes[0]).toEqual(state.writes[1]);
      await act(async () => state.finishWrite()); await screen.findByLabelText("Название сохранено");
  });

  it.each(["Ещё новее", "Исходное имя"])("does not mark newer draft %s saved by an earlier response", async (newer) => {
    const state = await mount(true);
    fireEvent.change(titleEditor(), { target: { value: "Новое имя" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить название" }));
    await waitFor(() => expect(state.busy()).toBe(1), { timeout: 2500 });
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveAttribute("readonly");
    await act(async () => state.finishWrite());
    await waitFor(() => expect(state.busy()).toBe(0));
    fireEvent.change(titleEditor(), { target: { value: newer } });
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue(newer);
    expect(screen.queryByLabelText("Название сохранено")).not.toBeInTheDocument();
  });

  it.skipIf(kind === "my-tasks")("does not silently rebase queued title/description drafts after a realtime version advance", async () => {
    const state = await mount();
    fireEvent.change(titleEditor(), { target: { value: "Мой заголовок" } });
    if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    fireEvent.change(screen.getByRole("textbox", { name: "Редактор описания" }), { target: { value: "Моё описание" } });
    state.remote("task:updated", { title: "Чужой заголовок", description: "Чужое описание", version: 8, priority: "LOW" });
    await screen.findByRole("button", { name: "Обновить карточку" });
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Мой заголовок");
    expect(screen.getByRole("textbox", { name: "Редактор описания" })).toHaveValue("Моё описание");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    expect(state.writes).toHaveLength(0);
  });

  it.skipIf(kind === "my-tasks").each(["task:updated", "task:moved"])("marks the open card stale on %s without replacing a description draft", async (event) => {
    const state = await mount();
    if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    fireEvent.change(screen.getByRole("textbox", { name: "Редактор описания" }), { target: { value: "Мой черновик" } });
    state.remote(event, { columnId: "waiting", status: "COLUMN_CUSTOM", version: 8, priority: "LOW", description: "Описание коллеги" });
    await screen.findByRole("button", { name: "Обновить карточку" });
    expect(screen.getByRole("combobox", { name: "Приоритет задачи" })).toHaveTextContent("Срочно");
    expect(screen.getByRole("textbox", { name: "Редактор описания" })).toHaveValue("Мой черновик");
    expect(state.writes).toHaveLength(0);
  });

  it.skipIf(kind === "my-tasks")("preserves a title being typed when a colleague changes the title", async () => {
    const state = await mount();
    fireEvent.change(titleEditor(), { target: { value: "Мой заголовок" } });
    state.remote("task:updated", { title: "Заголовок коллеги", columnId: "waiting", version: 8, priority: "LOW" });
    await screen.findByRole("button", { name: "Обновить карточку" });
    expect(screen.getByRole("combobox", { name: "Приоритет задачи" })).toHaveTextContent("Срочно");
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Мой заголовок");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    expect(state.canonical().title).toBe("Заголовок коллеги"); expect(state.writes).toHaveLength(0);
  });

  it.skipIf(kind === "my-tasks")("ignores another task's events", async () => {
    const state = await mount();
    state.remote("task:updated", { columnId: "waiting", version: 8 }, "other-task");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(screen.queryByRole("combobox", { name: "Колонка задачи" })).not.toBeInTheDocument();
  });

  it.skipIf(kind === "my-tasks")("requires explicit recovery before editing against a colleague's newer baseline", async () => {
    const state = await mount();
    fireEvent.change(titleEditor(), { target: { value: "Мой черновик" } });
    state.remote("task:updated", { title: "Заголовок коллеги", columnId: "waiting", version: 8, priority: "LOW" });
    await userEvent.click(await screen.findByRole("button", { name: "Обновить карточку" }));
    await screen.findByText("Найден черновик");
    await settleInitialization();
    expect(screen.getByRole("combobox", { name: "Приоритет задачи" })).toHaveTextContent("Не срочно");
    expect(state.writes).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Удалить несохранённый текст" }));
    fireEvent.change(titleEditor(), { target: { value: "Исходное имя" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить название" }));
    await waitFor(() => expect(state.canonical().title).toBe("Исходное имя"), { timeout: 2500 });
  });

  it.each([{ index: 0, field: "priority", away: "Не срочно", back: "Срочно", initial: "URGENT", next: "LOW" }])(
    "persists legacy urgent → nonurgent → canonical urgent without extra $field writes", async ({ index, field, away, back, initial, next }) => {
      const state = await mount();
      await choose(index, away);
      await waitFor(() => expect(state.canonical()[field as "priority" | "status"]).toBe(next));
      await settleInitialization();
      await choose(index, back);
      await waitFor(() => expect(state.canonical()[field as "priority" | "status"]).toBe(initial));
      expect(state.writes).toHaveLength(2);
    });

  it("preserves the server-confirmed title when saving another field", async () => {
    const state = await mount();
    fireEvent.change(titleEditor(), { target: { value: "Новое имя" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить название" }));
    await waitFor(() => expect(state.canonical().title).toBe("Новое имя · сервер"), { timeout: 2500 });
    await settleInitialization();
    await choose(0, "Не срочно");
    await waitFor(() => expect(state.writes).toHaveLength(2));
    expect(state.canonical().title).toBe("Новое имя · сервер");
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Новое имя · сервер");
  });

  it.each(["priority", "deadline"] as const)("preserves a title draft and explicit save when an earlier %s response arrives", async (field) => {
    const state = await mount(true);
    if (field === "priority") {
      await choose(0, "Не срочно");
    } else {
      await userEvent.click(screen.getByRole("button", { name: "Установить" }));
      await userEvent.click(await screen.findByRole("button", { name: "Выбрать дату" }));
      await userEvent.click(screen.getByRole("textbox", { name: "Тема обращения" }));
    }
    await waitFor(() => expect(state.busy()).toBe(1));
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveAttribute("readonly");
    await act(async () => { state.finishWrite(); });
    await waitFor(() => expect(state.busy()).toBe(0));
    fireEvent.change(titleEditor(), { target: { value: "Новое имя" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить название" }));
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Новое имя");
    await waitFor(() => expect(state.writes).toHaveLength(2), { timeout: 2500 });
    expect(state.writes[1].changes).toEqual({ title: "Новое имя" });
    await act(async () => { state.finishWrite(); });
    await waitFor(() => expect(state.busy()).toBe(0));
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Новое имя · сервер");
  });

  it("restores the original description after a saved edit", async () => {
    const state = await mount();
    if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    fireEvent.change(screen.getByRole("textbox", { name: "Редактор описания" }), { target: { value: "Новое описание" } });
    await userEvent.click(screen.getByRole("button", { name: "Сохранить описание" }));
    await waitFor(() => expect(state.canonical().description).toBe("Новое описание"));
    await settleInitialization();
    if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    fireEvent.change(screen.getByRole("textbox", { name: "Редактор описания" }), { target: { value: "Исходное описание" } });
    await userEvent.click(screen.getByRole("button", { name: "Сохранить описание" }));
    await waitFor(() => expect(state.canonical().description).toBe("Исходное описание"));
    expect(state.writes).toHaveLength(2);
  });

  it("keeps an unsaved description when a different field is confirmed", async () => {
    const state = await mount();
    if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    fireEvent.change(screen.getByRole("textbox", { name: "Редактор описания" }), { target: { value: "Несохранённый черновик" } });
    await choose(0, "Не срочно");
    await waitFor(() => expect(state.busy()).toBe(0));
    expect(screen.getByRole("textbox", { name: "Редактор описания" })).toHaveValue("Несохранённый черновик");
    expect(state.canonical().description).toBe("Исходное описание");
  });

  it("does not swallow a priority choice immediately after the previous save", async () => {
    const state = await mount();
    await choose(0, "Не срочно");
    await waitFor(() => expect(state.busy()).toBe(0));
    await choose(0, "Срочно");
    await waitFor(() => expect(state.canonical().priority).toBe("URGENT"));
    expect(state.writes).toHaveLength(2);
  });

  it("persists deadline null → date → null", async () => {
    const state = await mount();
    const trigger = screen.getByRole("button", { name: "Установить" });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("button", { name: "Выбрать дату" }));
    await waitFor(() => expect(state.canonical().deadline).toBe("2026-09-19T12:00:00.000Z"));
    await settleInitialization();
    if (trigger.getAttribute("aria-expanded") !== "true") await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("button", { name: "Очистить дату" }));
    await waitFor(() => expect(state.canonical().deadline).toBe(null));
    expect(state.writes).toHaveLength(2);
  });

  it("keeps raw column selection out of every task entrypoint", async () => {
    const state = await mount();
    expect(screen.queryByRole("combobox", { name: "Колонка задачи" })).not.toBeInTheDocument();
    expect(state.canonical().columnId).toBe("todo");
    expect(state.writes).toHaveLength(0);
  });

  it("names the priority control through the real entrypoint and gives the direct card page exactly one h1", async () => {
    await mount();
    expect(screen.getByRole("combobox", { name: "Приоритет задачи" })).toBeInTheDocument();
    if (kind === "detail") {
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(screen.getByRole("heading", { level: 1, name: initialTask.title })).toBeInTheDocument();
    }
  });

  it.skipIf(kind === "my-tasks")("keeps route B and its cache untouched when route A finishes saving", async () => {
    const state = await mount(true);
    for (const suffix of ["1", "2"]) {
      state.client.setQueryData(["task", `task-${suffix}`], {});
      state.client.setQueryData(["tasks", `project-${suffix}`], []);
      state.client.setQueryData(["activities", `task-${suffix}`], []);
    }
    await choose(0, "Не срочно");
    await waitFor(() => expect(state.busy()).toBe(1));
    fireEvent.change(titleEditor(), { target: { value: "Черновик задачи A" } });
    state.rerender({ ...initialTask, id: "task-2", projectId: "project-2", title: "Задача B" });
    await act(async () => { state.finishWrite(); });
    await waitFor(() => expect(state.busy()).toBe(0));
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Задача B");
    expect(state.client.getQueryState(["task", "task-1"])?.isInvalidated).toBe(false);
    expect(state.client.getQueryState(["tasks", "project-1"])?.isInvalidated).toBe(false);
    expect(state.client.getQueryState(["activities", "task-1"])?.isInvalidated).toBe(false);
    expect(state.client.getQueryState(["task", "task-2"])?.isInvalidated).toBe(false);
    expect(state.client.getQueryState(["tasks", "project-2"])?.isInvalidated).toBe(false);
    expect(state.client.getQueryState(["activities", "task-2"])?.isInvalidated).toBe(false);
  });
});

