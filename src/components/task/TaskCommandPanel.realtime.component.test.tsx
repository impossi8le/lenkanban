import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";
const transport = vi.hoisted(() => ({ read: vi.fn(), patch: vi.fn(), capability: vi.fn(), refresh: undefined as undefined | (() => Promise<void>), actor: "author" }));
vi.mock("@/lib/api", () => ({ apiFetch: transport.capability }));
vi.mock("@/lib/task-scalar-transport", async original => ({ ...await original<typeof import("@/lib/task-scalar-transport")>(), readTaskDetails: transport.read, patchScalarCommand: transport.patch }));
vi.mock("@/hooks/useTaskDetailRealtime", () => ({ useTaskDetailRealtime: (_project: string, _task: string, refresh: () => Promise<void>) => { transport.refresh = refresh; } }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: transport.actor } } }) }));
vi.mock("next/dynamic", () => ({ default: (loader: () => unknown) => function Editor(props: { content: string; editable?: boolean; onChange: (value: string) => void }) {
  return loader.toString().includes("RichTextEditor") ? <textarea aria-label="Описание проверки" value={props.content} readOnly={!props.editable} onChange={event => props.onChange(event.target.value)} /> : null;
} }));
vi.mock("@/components/task/ActivityTimeline", () => ({ ActivityTimeline: () => null }));
vi.mock("@/components/task/TaskAttachments", () => ({ TaskAttachments: () => null }));
vi.mock("@/components/task/AssigneeSelector", () => ({ AssigneeSelector: () => null }));
vi.mock("@/components/task/TaskRequestLifecycleControls", () => ({ TaskRequestLifecycleControls: ({ onChanged }: { onChanged?: () => void }) => <button onClick={onChanged}>Сохранённый переход</button> }));
vi.mock("@/lib/telemetry/client", () => ({ getBrowserTelemetryClient: () => undefined }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
import { TaskCommandPanel } from "./TaskCommandPanel";

const task: TaskType = { id: "task", projectId: "project", title: "Исходное название", description: "Исходное описание", columnId: "new", column: { id: "new", name: "Новые", color: "#336699" }, priority: "LOW", version: 7, position: 1, assignees: [] };
const assigned: TaskType = { ...task, version: 8, columnId: "work", column: { id: "work", name: "В работе", color: "#336699" }, request: { state: "IN_PROGRESS", executorId: "executor" }, assignees: [{ id: "assignment", user: { id: "executor", name: "Алексей Специалист", email: "executor@example.invalid" } }] };
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); transport.actor = "author";
  const frame = document.createElement("iframe"); document.body.appendChild(frame); vi.stubGlobal("localStorage", frame.contentWindow!.localStorage); localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); transport.read.mockResolvedValue(assigned);
  transport.capability.mockResolvedValue({ taskId: "task", projectId: "project", version: 7, marked: false, deleted: false,
    permissions: { canEditFields: true, canEditDescription: true, canSetDeadline: false, canUseLegacyAssignees: false } });
});
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); document.querySelectorAll("iframe").forEach(frame => frame.remove()); });
async function mount() {
  const props = { projectId: "project", taskId: "task", task, onClose: vi.fn() };
  const ui = () => <QueryClientProvider client={client}><TaskCommandPanel {...props} /></QueryClientProvider>;
  const view = render(ui()); await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  return { ...view, ui };
}
it("updates a clean actual card after another executor takes it", async () => {
  await mount(); await act(async () => { await transport.refresh!(); });
  expect(screen.getAllByText("Алексей Специалист").length).toBeGreaterThan(0);
  expect(screen.getByRole("textbox", { name: "Тема обращения" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Обновить карточку" })).not.toBeInTheDocument();
});
it("refreshes a clean card after its own committed lifecycle action", async () => {
  await mount(); await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Сохранённый переход" })); });
  expect(screen.getAllByText("Алексей Специалист").length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Обновить карточку" })).not.toBeInTheDocument();
});
it.each(["title", "description"])("preserves a dirty %s and its original command baseline", async field => {
  await mount();
  if (field === "title") fireEvent.click(screen.getByRole("button", { name: "Изменить тему обращения" }));
  if (field === "description") fireEvent.click(screen.getByRole("button", { name: "Изменить описание" }));
  const input = screen.getByRole("textbox", { name: field === "title" ? "Тема обращения" : "Описание проверки" });
  fireEvent.change(input, { target: { value: "Несохранённый текст" } });
  await act(async () => { await transport.refresh!(); });
  expect(input).toHaveValue("Несохранённый текст");
  expect(screen.getByRole("button", { name: "Обновить карточку" })).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); }); expect(transport.patch).not.toHaveBeenCalled();
});
it("captures typing during an actual fresh read before it can advance the baseline", async () => {
  await mount(); let finish!: (task: TaskType) => void; transport.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  let reading!: Promise<void>; act(() => { reading = transport.refresh!(); });
  fireEvent.click(screen.getByRole("button", { name: "Изменить тему обращения" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Тема обращения" }), { target: { value: "Ввод во время чтения" } });
  await act(async () => { finish(assigned); await reading; });
  expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Ввод во время чтения");
  expect(screen.getByRole("button", { name: "Обновить карточку" })).toBeInTheDocument();
});
it("keeps an actor-scoped stored draft behind recovery before any input event", async () => {
  localStorage.setItem(`lenkanban:task-draft:v1:${JSON.stringify(["author", "task"])}`, JSON.stringify({ description: "Сохранённый локальный черновик" }));
  await mount(); await act(async () => { await transport.refresh!(); });
  expect(screen.getByText("Найден черновик")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Обновить карточку" })).toBeInTheDocument();
  expect(screen.queryByText("Алексей Специалист")).not.toBeInTheDocument();
});
it("rejects a late clean response after account identity changes", async () => {
  const view = await mount(); let finish!: (task: TaskType) => void; transport.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  let reading!: Promise<void>; act(() => { reading = transport.refresh!(); });
  transport.actor = "other"; view.rerender(view.ui());
  await act(async () => { finish(assigned); await reading; });
  expect(screen.getByRole("alert")).toHaveTextContent("Учётная запись изменилась");
  expect(screen.queryByText("Алексей Специалист")).not.toBeInTheDocument();
});
