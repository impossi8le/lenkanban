import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskColumnSelector, type TaskColumnSelectorProps } from "./TaskColumnSelector";

const columns = [
  { id: "column-inbox", name: "Входящие заявки", projectId: "project", position: 0, workflowKey: "TODO", status: "TODO" },
  { id: "column-custom", name: "Ожидает деталей", projectId: "project", position: 1, workflowKey: "COLUMN_CUSTOM", status: "COLUMN_CUSTOM" },
];
const clients: QueryClient[] = [];
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "actor" } } }) }));
beforeEach(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async url => Response.json({ success: true, data: String(url).endsWith('/task-permissions') ? { canChangeStatus: true } : columns })));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });

function mount(props: Partial<TaskColumnSelectorProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const onChange = vi.fn();
  const initial = { projectId: "project", columnId: "column-inbox", onChange, ...props };
  const tree = (next: TaskColumnSelectorProps) => <QueryClientProvider client={client}><TaskColumnSelector {...next} /></QueryClientProvider>;
  const view = render(tree(initial));
  return { onChange, rerender: (next: Partial<TaskColumnSelectorProps>) => view.rerender(tree({ ...initial, ...next })) };
}
async function open() {
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Колонка задачи" })).not.toBeDisabled());
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Колонка задачи" }), { key: "Enter" });
}

it("disables selection while the real columns request is loading", () => {
  vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
  const state = mount();
  expect(screen.getByRole("combobox", { name: "Колонка задачи" })).toBeDisabled();
  expect(screen.getByText("Загрузка колонок…")).toBeInTheDocument();
  expect(state.onChange).not.toHaveBeenCalled();
});

it("reads the API array and emits a custom column ID instead of status or a mutation", async () => {
  const state = mount();
  await open();
  fireEvent.keyDown(await screen.findByRole("option", { name: "Ожидает деталей" }), { key: "Enter" });
  expect(state.onChange).toHaveBeenCalledExactlyOnceWith("column-custom");
  expect(fetch).toHaveBeenCalledWith("/api/projects/project/columns", { signal: expect.any(AbortSignal) });
  expect(fetch).toHaveBeenCalledWith("/api/projects/project/task-permissions", { signal: expect.any(AbortSignal) });
});

it("keeps the selected value controlled by its owner", async () => {
  const state = mount();
  await open();
  fireEvent.keyDown(await screen.findByRole("option", { name: "Ожидает деталей" }), { key: "Enter" });
  expect(screen.getByRole("combobox", { name: "Колонка задачи" })).toHaveTextContent("Входящие заявки");
  state.rerender({ columnId: "column-custom" });
  expect(screen.getByRole("combobox", { name: "Колонка задачи" })).toHaveTextContent("Ожидает деталей");
});

it("does not emit a save when the current column is selected again", async () => {
  const state = mount();
  await open();
  fireEvent.keyDown(await screen.findByRole("option", { name: "Входящие заявки" }), { key: "Enter" });
  expect(state.onChange).not.toHaveBeenCalled();
});

it("shows an empty state without offering hardcoded workflow statuses", async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ success: true, data: [] }));
  mount();
  expect(await screen.findByText("В проекте нет колонок")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Колонка задачи" })).toBeDisabled();
  expect(screen.queryByText("К выполнению")).not.toBeInTheDocument();
});

it("reports a load failure instead of pretending the project is empty", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ error: { message: "Unavailable" } }, { status: 503 }));
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить колонки");
  expect(screen.getByRole("combobox", { name: "Колонка задачи" })).toBeDisabled();
  expect(screen.queryByText("В проекте нет колонок")).not.toBeInTheDocument();
});

it("respects the owner's saving/disabled state", async () => {
  const state = mount({ disabled: true });
  await screen.findByText("Входящие заявки");
  expect(screen.getByRole("combobox", { name: "Колонка задачи" })).toBeDisabled();
  expect(state.onChange).not.toHaveBeenCalled();
});

it("does not replace current project options with a late response from the previous task", async () => {
  let resolveOld!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(async url => String(url).endsWith('/task-permissions')
    ? Response.json({ success: true, data: { canChangeStatus: true } }) : String(url).includes("/project/columns")
    ? new Promise<Response>(resolve => { resolveOld = resolve; })
    : Response.json({ success: true, data: [{ id: "new-column", name: "Новый проект — колонка", position: 0 }] }));
  const state = mount();
  state.rerender({ projectId: "other-project", columnId: "new-column" });
  await screen.findByText("Новый проект — колонка");
  await act(async () => resolveOld(Response.json({ success: true, data: columns })));
  await open();
  expect(screen.getByRole("option", { name: "Новый проект — колонка" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Ожидает деталей" })).not.toBeInTheDocument();
  expect(state.onChange).not.toHaveBeenCalled();
});

it("keeps a readable column disabled when the applicant cannot change status", async () => {
  vi.mocked(fetch).mockImplementation(async url => Response.json({ success: true, data: String(url).endsWith('/task-permissions') ? { canChangeStatus: false } : columns }));
  const state = mount();
  await screen.findByText("Входящие заявки");
  expect(screen.getByRole("combobox", { name: "Колонка задачи" })).toBeDisabled();
  expect(state.onChange).not.toHaveBeenCalled();
});
