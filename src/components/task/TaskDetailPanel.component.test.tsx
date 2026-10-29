import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";
import { TaskDetailPanel } from "./TaskDetailPanel";

// The relation panel has its own QueryClient/API lifecycle suite; these tests
// isolate the card field editor and its pending-intent boundaries.
vi.mock("@/components/task/TaskRelatedRequests", () => ({ TaskRelatedRequests: () => null }));

vi.mock("next/dynamic", () => ({
  default: (loader: () => unknown) => function DynamicComponentStub(props: { content: string; editable?: boolean; onChange: (value: string) => void; onSave: () => void }) {
    return loader.toString().includes("RichTextEditor") ? <><textarea aria-label="Редактор описания" readOnly={props.editable === false} value={props.content} onChange={e => props.onChange(e.target.value)} /><button onClick={props.onSave}>Сохранить описание</button></> : null;
  },
}));

vi.mock("@/components/task/ActivityTimeline", () => ({
  ActivityTimeline: () => null,
}));

vi.mock("@/components/task/TaskAttachments", () => ({
  TaskAttachments: () => null,
}));

vi.mock("@/components/task/TaskChecklist", () => ({
  TaskChecklist: () => null,
}));

vi.mock("@/components/task/TagPicker", () => ({
  TagPicker: () => null,
}));

vi.mock("@/components/task/AssigneeSelector", () => ({
  AssigneeSelector: () => null,
}));

vi.mock("@/components/task/TaskColumnSelector", () => ({
  TaskColumnSelector: () => null,
}));

vi.mock("@/components/templates/TemplateDialog", () => ({
  TemplateDialog: () => null,
}));

const auth = vi.hoisted(() => ({ userId: "user-1" }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: auth.userId } } }) }));
beforeEach(() => {
  auth.userId = "user-1";
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  vi.stubGlobal("localStorage", frame.contentWindow!.localStorage);
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.querySelectorAll("iframe").forEach(f => f.remove()); });

function task(id: string, title: string): TaskType {
  return {
    id,
    title,
    description: "",
    status: "TODO",
    columnId: "todo",
    priority: "MEDIUM",
    position: 1024,
    projectId: "project-1",
    assignees: [],
    tags: [],
    attachments: [],
    checklistItems: [],
  };
}

function editableTitle() {
  const edit = screen.queryByRole("button", { name: "Изменить тему обращения" });
  if (edit) fireEvent.click(edit);
  return screen.getByRole("textbox", { name: "Тема обращения" });
}

describe("TaskDetailPanel title field", () => {
  it("keeps an early explicit title edit until its Save action", async () => {
    vi.useFakeTimers();
    try {
      const onSave = vi.fn();
      render(<TaskDetailPanel task={task("task-1", "Сервер")} onClose={vi.fn()} onSave={onSave} />);
      const input = editableTitle();
      expect(input).toBeEnabled();
      fireEvent.change(input, { target: { value: "Ранний ввод" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(99); });
      expect(onSave).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(onSave).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Сохранить название" }));
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledWith("task-1", { title: "Ранний ввод" }, {
        onSuccess: expect.any(Function), onError: expect.any(Function),
      });
    } finally { vi.useRealTimers(); }
  });

  it("saves an eligible early deadline edit when initialization completes", async () => {
    vi.useFakeTimers();
    try {
      const onSave = vi.fn();
      render(<TaskDetailPanel task={{ ...task("task-1", "Дедлайн"), deadline: new Date("2026-09-18T12:00:00Z"),
        assignees: [{ id: "assignment", user: { id: "user-1", name: "User", email: "user@example.invalid" } }] }} onClose={vi.fn()} onSave={onSave} />);
      const clear = screen.getByRole("button", { name: "Очистить дедлайн" });
      expect(clear).toBeEnabled();
      fireEvent.click(clear);
      await act(async () => { await vi.advanceTimersByTimeAsync(99); });
      expect(onSave).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(onSave).toHaveBeenCalledExactlyOnceWith("task-1", { title: "Дедлайн", deadline: null });
    } finally { vi.useRealTimers(); }
  });

  it("saves an early priority selection when initialization completes", async () => {
    vi.useFakeTimers();
    try {
      const onSave = vi.fn();
      render(<TaskDetailPanel task={task("task-1", "Приоритет")} onClose={vi.fn()} onSave={onSave} />);
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Приоритет задачи" }), { key: "Enter" });
      fireEvent.keyDown(screen.getByRole("option", { name: /^Срочно$/ }), { key: "Enter" });
      await act(async () => { await vi.advanceTimersByTimeAsync(99); });
      expect(onSave).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(onSave).toHaveBeenCalledExactlyOnceWith("task-1", { title: "Приоритет", priority: "URGENT" }, { onSuccess: expect.any(Function), onError: expect.any(Function) });
    } finally { vi.useRealTimers(); }
  });

  it("does not save initial server fields or carry an early edit across a task switch", async () => {
    vi.useFakeTimers();
    try {
      const onSave = vi.fn();
      const props = { onClose: vi.fn(), onSave };
      const view = render(<TaskDetailPanel {...props} task={{ ...task("task-1", "Первая"), priority: "HIGH", deadline: new Date("2026-09-18T12:00:00Z"),
        assignees: [{ id: "assignment", user: { id: "user-1", name: "User", email: "user@example.invalid" } }] }} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      expect(onSave).not.toHaveBeenCalled();
      view.rerender(<TaskDetailPanel {...props} task={task("task-2", "Вторая")} />);
      fireEvent.change(editableTitle(), { target: { value: "Не переносить" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      view.rerender(<TaskDetailPanel {...props} task={task("task-3", "Третья")} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Третья");
      expect(onSave).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("waits for the new task's initialization instead of an old task timer", async () => {
    vi.useFakeTimers();
    try {
      const onSave = vi.fn();
      const props = { onClose: vi.fn(), onSave };
      const withDeadline = (id: string) => ({ ...task(id, id), deadline: new Date("2026-09-18T12:00:00Z"),
        assignees: [{ id: "assignment", user: { id: "user-1", name: "User", email: "user@example.invalid" } }] });
      const view = render(<TaskDetailPanel {...props} task={withDeadline("task-1")} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      view.rerender(<TaskDetailPanel {...props} task={withDeadline("task-2")} />);
      fireEvent.click(screen.getByRole("button", { name: "Очистить дедлайн" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(onSave).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(onSave).toHaveBeenCalledExactlyOnceWith("task-2", { title: "task-2", deadline: null });
    } finally { vi.useRealTimers(); }
  });

  it("preserves an early deadline intent across a same-task server update during initialization", async () => {
    vi.useFakeTimers();
    try {
      const onSave = vi.fn();
      const current = { ...task("task-1", "Дедлайн"), deadline: new Date("2026-09-18T12:00:00Z"),
        assignees: [{ id: "assignment", user: { id: "user-1", name: "User", email: "user@example.invalid" } }] };
      const props = { onClose: vi.fn(), onSave };
      const view = render(<TaskDetailPanel {...props} task={current} />);
      fireEvent.click(screen.getByRole("button", { name: "Очистить дедлайн" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      view.rerender(<TaskDetailPanel {...props} task={{ ...current, priority: "LOW" }} />);
      expect(screen.getByRole("button", { name: "Установить" })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(onSave).toHaveBeenCalledExactlyOnceWith("task-1", { title: "Дедлайн", deadline: null });
    } finally { vi.useRealTimers(); }
  });

  it("retains an early description edit across a same-task update and saves only explicitly", async () => {
    vi.useFakeTimers();
    try {
      const onSave = vi.fn();
      const current = { ...task("task-1", "Описание"), description: "Сервер" };
      const props = { onClose: vi.fn(), onSave };
      const view = render(<TaskDetailPanel {...props} task={current} />);
      if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
      fireEvent.change(screen.getByRole("textbox", { name: "Редактор описания" }), { target: { value: "Раннее описание" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      view.rerender(<TaskDetailPanel {...props} task={{ ...current, description: "Коллега изменил" }} />);
      expect(screen.getByRole("textbox", { name: "Редактор описания" })).toHaveValue("Раннее описание");
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      expect(onSave).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Сохранить описание" }));
      expect(onSave).toHaveBeenCalledExactlyOnceWith("task-1", { title: "Описание", description: "Раннее описание" }, {
        onSuccess: expect.any(Function), onError: expect.any(Function),
      });
    } finally { vi.useRealTimers(); }
  });

  it("does not submit an early deadline intent after current executor authority is lost", async () => {
    vi.useFakeTimers();
    try {
      const onSave = vi.fn();
      const current = { ...task("task-1", "Дедлайн"), deadline: new Date("2026-09-18T12:00:00Z"),
        assignees: [{ id: "assignment", user: { id: "user-1", name: "User", email: "user@example.invalid" } }] };
      const props = { onClose: vi.fn(), onSave };
      const view = render(<TaskDetailPanel {...props} task={current} />);
      fireEvent.click(screen.getByRole("button", { name: "Очистить дедлайн" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      view.rerender(<TaskDetailPanel {...props} task={{ ...current, assignees: [] }} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      expect(onSave).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Не установлен" })).toBeDisabled();
    } finally { vi.useRealTimers(); }
  });

  it("does not submit another account's early title intent after an account switch", async () => {
    vi.useFakeTimers();
    try {
      const onSave = vi.fn();
      const props = { task: task("task-1", "Сервер"), onClose: vi.fn(), onSave };
      const view = render(<TaskDetailPanel {...props} />);
      fireEvent.change(editableTitle(), { target: { value: "Первый аккаунт" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      auth.userId = "user-2";
      view.rerender(<TaskDetailPanel {...props} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Сервер");
      expect(onSave).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("hides advanced sections and locks deadline for an ordinary author", () => {
    render(<TaskDetailPanel task={task("task-1", "Simple")} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.queryByRole("combobox", { name: "Колонка задачи" })).not.toBeInTheDocument();
    for (const text of ["Теги", "Чек-лист", "Заявка"]) expect(screen.queryByText(text)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Не установлен" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Очистить дедлайн" })).not.toBeInTheDocument();
  });

  it("names the priority combobox and provides one heading at the requested entrypoint level", () => {
    const props = { task: task("task-1", "Доступная задача"), onClose: vi.fn(), onSave: vi.fn() };
    const view = render(<TaskDetailPanel {...props} headingLevel={1} />);
    expect(screen.getByRole("combobox", { name: "Приоритет задачи" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Доступная задача", level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Доступная задача", level: 2 })).not.toBeInTheDocument();
    view.rerender(<TaskDetailPanel {...props} />);
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Доступная задача", level: 2 })).toHaveLength(1);
  });
  it("keeps a restored description until explicit acknowledgement even when it matches the baseline", async () => {
    const props = { task: { ...task("task-1", "Сервер"), description: "Исходное" }, onClose: vi.fn(), onSave: vi.fn() };
    const first = render(<TaskDetailPanel {...props} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
    if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    fireEvent.change(screen.getByRole("textbox", { name: "Редактор описания" }), { target: { value: "Временное" } });
    if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    fireEvent.change(screen.getByRole("textbox", { name: "Редактор описания" }), { target: { value: "Исходное" } });
    first.unmount();
    const second = render(<TaskDetailPanel {...props} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
    await userEvent.click(screen.getByRole("button", { name: "Восстановить черновик" }));
    second.rerender(<TaskDetailPanel {...props} task={{ ...props.task, priority: "LOW" }} />);
    second.rerender(<TaskDetailPanel {...props} task={{ ...props.task, description: "От коллеги" }} />);
    expect(screen.getByRole("textbox", { name: "Редактор описания" })).toHaveValue("Исходное");
  });
  it("preserves an explicitly restored title across a colleague update even when it matched the old baseline", async () => {
    const props = { task: task("task-1", "Сервер"), onClose: vi.fn(), onSave: vi.fn() };
    const first = render(<TaskDetailPanel {...props} />);
    fireEvent.change(editableTitle(), { target: { value: "Временное" } });
    fireEvent.change(editableTitle(), { target: { value: "Сервер" } });
    first.unmount();
    const second = render(<TaskDetailPanel {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Восстановить черновик" }));
    second.rerender(<TaskDetailPanel {...props} task={task("task-1", "Коллега изменил")} />);
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Сервер");
  });
  it("isolates drafts across accounts and tasks and allows explicit discard", async () => {
    const props = { task: task("task-1", "Сервер"), onClose: vi.fn(), onSave: vi.fn() };
    const view = render(<TaskDetailPanel {...props} />);
    fireEvent.change(editableTitle(), { target: { value: "Личный черновик" } });
    auth.userId = "user-2";
    view.rerender(<TaskDetailPanel {...props} />);
    expect(screen.queryByText("Найден черновик")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Сервер");
    auth.userId = "user-1";
    view.rerender(<TaskDetailPanel {...props} task={task("task-2", "Другая задача")} />);
    expect(screen.queryByText("Найден черновик")).not.toBeInTheDocument();
    view.rerender(<TaskDetailPanel {...props} />);
    expect(screen.getByText("Найден черновик")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Удалить несохранённый текст" }));
    view.unmount();
    render(<TaskDetailPanel {...props} />);
    expect(screen.queryByText("Найден черновик")).not.toBeInTheDocument();
  });

  it("keeps failed saves recoverable and clears only confirmed fields", async () => {
    const onSave = vi.fn();
    const props = { task: task("task-1", "Сервер"), onClose: vi.fn(), onSave };
    const view = render(<TaskDetailPanel {...props} />);
    fireEvent.change(editableTitle(), { target: { value: "Заголовок" } });
    if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    fireEvent.change(screen.getByRole("textbox", { name: "Редактор описания" }), { target: { value: "Описание" } });
    await userEvent.click(screen.getByRole("button", { name: "Сохранить описание" }));
    act(() => onSave.mock.calls[0][2].onError());
    expect(screen.getByText(/Описание не сохранено/)).toBeInTheDocument();
    view.unmount();
    const second = render(<TaskDetailPanel {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Восстановить черновик" }));
    await userEvent.click(screen.getByRole("button", { name: "Сохранить описание" }));
    act(() => onSave.mock.calls[1][2].onSuccess({ title: "Сервер" }));
    second.unmount();
    render(<TaskDetailPanel {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Восстановить черновик" }));
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Заголовок");
    expect(screen.getByRole("textbox", { name: "Редактор описания" })).toHaveValue("");
  });
  it("recovers both fields after remount without submitting until explicitly saved", async () => {
    const onSave = vi.fn();
    const props = { task: task("task-1", "Сервер"), onClose: vi.fn(), onSave };
    const first = render(<TaskDetailPanel {...props} />);
    fireEvent.change(editableTitle(), { target: { value: "Черновик" } });
    if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    fireEvent.change(screen.getByRole("textbox", { name: "Редактор описания" }), { target: { value: "Несохранённое описание" } });
    first.unmount();
    render(<TaskDetailPanel {...props} task={task("task-1", "Название коллеги")} />);
    expect(screen.getByText("Найден черновик")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Восстановить черновик" }));
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Черновик");
    expect(screen.getByRole("textbox", { name: "Редактор описания" })).toHaveValue("Несохранённое описание");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1150)); });
    expect(onSave).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Сохранить название" }));
    expect(onSave.mock.calls[0][1]).toEqual({ title: "Черновик" });
  });

  it("retains newer description when an older save succeeds", async () => {
    const onSave = vi.fn();
    const props = { task: task("task-1", "Сервер"), onClose: vi.fn(), onSave };
    const first = render(<TaskDetailPanel {...props} />);
    if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    fireEvent.change(screen.getByRole("textbox", { name: "Редактор описания" }), { target: { value: "Первая версия" } });
    await userEvent.click(screen.getByRole("button", { name: "Сохранить описание" }));
    if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    fireEvent.change(screen.getByRole("textbox", { name: "Редактор описания" }), { target: { value: "Новая версия" } });
    expect(onSave.mock.calls[0][2]).toBeDefined();
    act(() => onSave.mock.calls[0][2].onSuccess({ title: "Сервер" }));
    first.unmount();
    render(<TaskDetailPanel {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Восстановить черновик" }));
    expect(screen.getByRole("textbox", { name: "Редактор описания" })).toHaveValue("Новая версия");
  });
  it("clears the deadline through a named compact action", async () => {
    const onSave = vi.fn();
    render(<TaskDetailPanel task={{ ...task("task-1", "Дедлайн"), deadline: new Date("2026-09-18T12:00:00Z"), assignees: [{ id: "assignment", user: { id: "user-1", name: "User", email: "user@example.invalid" } }] }} onClose={vi.fn()} onSave={onSave} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    await userEvent.click(screen.getByRole("button", { name: "Очистить дедлайн" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("task-1", { title: "Дедлайн", deadline: null }));
    expect(screen.getByRole("button", { name: "Установить" })).toBeInTheDocument();
  });

  it("starts with a read-only description and reveals editing and empty uploads explicitly", async () => {
    const onSave=vi.fn();
    render(<TaskDetailPanel task={task("plain-open", "Обычное обращение")} onClose={vi.fn()} onSave={onSave}/>);
    const editor=screen.getByRole("textbox", {name:"Редактор описания"});
    expect(editor).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", {name:"Удалить"})).not.toBeInTheDocument();
    expect(screen.getByRole("button", {name:"Прикрепить файл"})).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    expect(editor).not.toHaveAttribute("readonly");
    await userEvent.click(screen.getByRole("button", {name:"Прикрепить файл"}));
    expect(screen.queryByRole("button", {name:"Прикрепить файл"})).not.toBeInTheDocument();
    expect(screen.getByText("Вложения")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps header actions accessible and targets the current task", async () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(<TaskDetailPanel task={task("task-1", "Действия")} onClose={onClose} onSave={vi.fn()} onDelete={onDelete} />);
    expect(screen.queryByRole("button", { name: "Сохранить как шаблон" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));
    expect(onDelete).toHaveBeenCalledWith("task-1");
    await userEvent.click(screen.getByRole("button", { name: "Закрыть окно" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders a closed panel when task is null", () => {
    render(<TaskDetailPanel task={null} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.queryByRole("dialog", { name: "Детали обращения" })).not.toBeInTheDocument();
  });

  it("exposes the visible title label as the textbox accessible name", () => {
    render(
      <TaskDetailPanel
        task={task("task-1", "Проверить доступность")}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("textbox", { name: "Тема обращения" }),
    ).toHaveValue("Проверить доступность");
  });

  it("uses a unique title-field id for every mounted panel", () => {
    render(
      <>
        <TaskDetailPanel
          task={task("task-1", "Первая задача")}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
        <TaskDetailPanel
          task={task("task-2", "Вторая задача")}
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
      </>,
    );

    const titleFields = screen.getAllByRole("textbox", {
      name: "Тема обращения",
    });
    expect(titleFields).toHaveLength(2);
    expect(titleFields[0].id).not.toBe("");
    expect(titleFields[1].id).not.toBe("");
    expect(titleFields[0].id).not.toBe(titleFields[1].id);
  });
});


it("shows separate labeled frames and keeps selecting text in read mode", async () => {
  const onSave = vi.fn();
  render(<TaskDetailPanel task={{ ...task("copy", "Текст для копирования"), description: "Описание для копирования" }} onClose={vi.fn()} onSave={onSave} />);
  const titleSection = screen.getByRole("region", { name: "Тема обращения" });
  const descriptionSection = screen.getByRole("region", { name: "Описание" });
  expect(titleSection).toHaveClass("border", "rounded-xl"); expect(descriptionSection).toHaveClass("border", "rounded-xl");
  const title = screen.getByRole("textbox", { name: "Тема обращения" }) as HTMLTextAreaElement;
  expect(title).toHaveAttribute("readonly"); expect(title).toBeEnabled();
  fireEvent.click(title); title.setSelectionRange(0, 5); fireEvent.select(title);
  fireEvent.click(screen.getByRole("textbox", { name: "Редактор описания" }));
  expect(title.selectionEnd).toBe(5); expect(title).toHaveAttribute("readonly");
  expect(screen.getByRole("textbox", { name: "Редактор описания" })).toHaveAttribute("readonly");
  expect(screen.queryByRole("button", { name: "Сохранить название" })).toBeNull();
  expect(screen.getByRole("button", { name: "Изменить тему обращения" })).toHaveAttribute("data-telemetry-action", "task.title.edit");
  expect(screen.getByRole("button", { name: "Изменить описание" })).toHaveAttribute("data-telemetry-action", "task.description.edit");
  expect(onSave).not.toHaveBeenCalled();
});

it("cancels explicit title changes without saving and retains the description draft", () => {
  const onSave = vi.fn();
  render(<TaskDetailPanel task={task("cancel-title", "Серверная тема")} onClose={vi.fn()} onSave={onSave} />);
  fireEvent.change(editableTitle(), { target: { value: "Отменить эту тему" } });
  fireEvent.click(screen.getByRole("button", { name: "Изменить описание" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Редактор описания" }), { target: { value: "Сохранить черновик описания" } });
  fireEvent.click(screen.getByRole("button", { name: "Отменить изменение темы" }));
  expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Серверная тема");
  expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveAttribute("readonly");
  expect(screen.getByRole("textbox", { name: "Редактор описания" })).toHaveValue("Сохранить черновик описания");
  expect(onSave).not.toHaveBeenCalled();
});

it("cancels description edits without mutation and shows the canonical text", () => {
  const onSave = vi.fn();
  render(<TaskDetailPanel task={{ ...task("cancel-description", "Тема"), description: "Описание сервера" }} onClose={vi.fn()} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: "Изменить описание" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Редактор описания" }), { target: { value: "Отменяемый текст" } });
  fireEvent.click(screen.getByRole("button", { name: "Отменить изменение описания" }));
  expect(screen.getByRole("textbox", { name: "Редактор описания" })).toHaveValue("Описание сервера");
  expect(screen.getByRole("textbox", { name: "Редактор описания" })).toHaveAttribute("readonly");
  expect(onSave).not.toHaveBeenCalled();
});

it("keeps title editing after a rejected save and returns to read mode only after acknowledgement", () => {
  const onSave = vi.fn();
  render(<TaskDetailPanel task={task("title-ack", "Тема сервера")} onClose={vi.fn()} onSave={onSave} />);
  fireEvent.change(editableTitle(), { target: { value: "Новая тема" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить название" }));
  act(() => onSave.mock.calls[0][2].onError());
  expect(screen.getByRole("textbox", { name: "Тема обращения" })).not.toHaveAttribute("readonly");
  expect(screen.getByRole("alert")).toHaveTextContent("Название не сохранено");
  fireEvent.click(screen.getByRole("button", { name: "Повторить сохранение названия" }));
  act(() => onSave.mock.calls[1][2].onSuccess({ title: "Новая тема" }));
  expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveAttribute("readonly");
  expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveValue("Новая тема");
});

it("keeps text selectable while scalar saves are blocked and prevents entering edit mode", () => {
  render(<TaskDetailPanel task={task("blocked", "Доступный для чтения текст")} onClose={vi.fn()} onSave={vi.fn()} scalarSaveBlocked />);
  expect(screen.getByRole("textbox", { name: "Тема обращения" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: "Изменить тему обращения" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Изменить описание" })).toBeDisabled();
});
