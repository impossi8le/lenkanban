import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";
import { TaskDetailPanel } from "./TaskDetailPanel";

vi.mock("@/components/task/TaskRelatedRequests", () => ({ TaskRelatedRequests: (props: { taskId: string; version?: number; actorId?: string; onChanged?: () => void }) =>
  <section aria-label="Связанные обращения" data-task-id={props.taskId} data-version={props.version} data-actor-id={props.actorId}>
    <button onClick={props.onChanged}>Проверка завершения изменения связи</button>
  </section> }));

vi.mock("next/dynamic", () => ({
  default: (loader: () => unknown) => function DynamicStub(props: { content: string; onChange: (value: string) => void; mode?: string }) {
    const [message, setMessage] = useState("");
    return loader.toString().includes("RichTextEditor")
      ? <textarea aria-label="Описание для проверки" value={props.content} onChange={event => props.onChange(event.target.value)} />
      : <div data-testid="conversation-mode" data-mode={props.mode}><textarea aria-label="Черновик сообщения" value={message} onChange={event => setMessage(event.target.value)} /></div>;
  },
}));
vi.mock("@/components/task/ActivityTimeline", () => ({ ActivityTimeline: () => <p>Событие истории</p> }));
vi.mock("@/components/task/TaskAttachments", () => ({ TaskAttachments: (props: { version?: number; canRemove?: boolean; onCommitted?: () => void }) =>
  <div data-testid="attachments-contract" data-version={props.version} data-can-remove={String(props.canRemove)}><button onClick={props.onCommitted}>Проверка завершения вложения</button></div> }));
vi.mock("@/components/task/TaskChecklist", () => ({ TaskChecklist: () => null }));
vi.mock("@/components/task/TagPicker", () => ({ TagPicker: () => null }));
vi.mock("@/components/task/AssigneeSelector", () => ({ AssigneeSelector: () => null }));
vi.mock("@/components/task/TaskColumnSelector", () => ({ TaskColumnSelector: () => null }));
vi.mock("@/components/templates/TemplateDialog", () => ({ TemplateDialog: () => null }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "responsive-user" } } }) }));

const task: TaskType = {
  id: "responsive-task", title: "Проверить мобильную карточку", description: "", status: "TODO",
  columnId: "todo", priority: "MEDIUM", position: 1024, projectId: "synthetic-project",
  assignees: [{ id: "assignment", user: { id: "responsive-user", name: "User", email: "user@example.invalid" } }], tags: [], attachments: [], checklistItems: [],
};

beforeEach(() => {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  vi.stubGlobal("localStorage", frame.contentWindow!.localStorage);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.querySelectorAll("iframe").forEach(frame => frame.remove());
});

describe("TaskDetailPanel section navigation", () => {
  it("uses the readable thread separately from action history and hides the empty original-file picker for a reader", () => {
    render(<TaskDetailPanel task={task} onClose={vi.fn()} onSave={vi.fn()} editCapabilities={{ canEditFields: false, canEditDescription: false, canSetDeadline: false, canUseLegacyAssignees: false }} />);
    const conversation = screen.getByRole("region", { name: "Переписка" });
    const history = screen.getByRole("region", { name: "История действий" });
    expect(conversation.contains(history)).toBe(false);
    expect(screen.getByTestId("conversation-mode")).toHaveAttribute("data-mode", "thread");
    expect(conversation.querySelector('[class*="h-[380px]"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Прикрепить файл" })).toBeNull();
    expect(screen.getByRole("button", { name: "Закрыть окно" })).toBeInTheDocument();
  });
  it.each([
    { allowed: true, blocked: false, expected: "true" },
    { allowed: false, blocked: false, expected: "false" },
    { allowed: true, blocked: true, expected: "false" },
  ])("passes fresh version/removal capability and committed refresh to attachments: %j", async ({ allowed, blocked, expected }) => {
    const onChanged = vi.fn();
    render(<TaskDetailPanel task={{ ...task, version: 7, attachments: [{ url: "/file", name: "file.pdf", size: 1, mime: "application/pdf" }] }} onClose={vi.fn()} onSave={vi.fn()} scalarSaveBlocked={blocked} onLifecycleChanged={onChanged}
      editCapabilities={{ canEditFields: false, canEditDescription: allowed, canSetDeadline: false, canUseLegacyAssignees: false }} />);
    expect(screen.getByTestId("attachments-contract")).toHaveAttribute("data-version", "7");
    expect(screen.getByTestId("attachments-contract")).toHaveAttribute("data-can-remove", expected);
    await userEvent.click(screen.getByRole("button", { name: "Проверка завершения вложения" }));
    expect(onChanged).toHaveBeenCalledOnce();
  });
  it("passes the current actor/task/version to related requests and refreshes the card after a committed link change", async () => {
    const onChanged = vi.fn();
    render(<TaskDetailPanel task={{ ...task, version: 12 }} onClose={vi.fn()} onSave={vi.fn()} onLifecycleChanged={onChanged} />);
    const related = screen.getByRole("region", { name: "Связанные обращения" });
    expect(related).toHaveAttribute("data-task-id", task.id);
    expect(related).toHaveAttribute("data-version", "12");
    expect(related).toHaveAttribute("data-actor-id", "responsive-user");
    await userEvent.click(screen.getByRole("button", { name: "Проверка завершения изменения связи" }));
    expect(onChanged).toHaveBeenCalledOnce();
  });
  it("keeps the header outside the only card scroll body and prevents a programmatically scrollable shell", () => {
    render(<TaskDetailPanel task={task} onClose={vi.fn()} onSave={vi.fn()} />);
    const shell = screen.getByRole("dialog", { name: "Детали обращения" });
    const header = screen.getByRole("group", { name: "Шапка карточки" });
    const body = screen.getByTestId("task-detail-scroll");
    // overflow:hidden is still programmatically scrollable. Native focus and
    // scrollIntoView can offset its header and leave an equally large blank tail.
    expect(shell).toHaveClass("overflow-clip", "flex-col");
    expect(shell).not.toHaveClass("overflow-hidden", "overflow-y-auto");
    expect(header.parentElement).toBe(shell); expect(body.parentElement).toBe(shell);
    expect(body.contains(header)).toBe(false);
    expect(header).toHaveClass("shrink-0");
    expect(body).toHaveClass("min-h-0", "flex-1", "overflow-y-auto", "overscroll-contain");
    expect(body.contains(screen.getByRole("region", { name: "Переписка" }))).toBe(true);
    fireEvent.scroll(body, { target: { scrollTop: 350 } });
    expect(header.parentElement).toBe(shell);
    expect(screen.getByRole("button", { name: "Закрыть окно" })).toBeInTheDocument();
  });
  it("lets the date popover consume Escape and returns focus to the opener after closing the task", async () => {
    const onClose = vi.fn();
    function Example() {
      const [openedTask, setOpenedTask] = useState<TaskType | null>(null);
      return <>
        <button type="button" onClick={() => setOpenedTask(task)}>Открыть задачу</button>
        <TaskDetailPanel task={openedTask} onClose={() => { onClose(); setOpenedTask(null); }} onSave={vi.fn()} />
      </>;
    }
    render(<Example />);
    const opener = screen.getByRole("button", { name: "Открыть задачу" });
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole("button", { name: "Установить" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(opener).toHaveFocus();
  });

  it("shows discussion inline and expands history without replacing the request", async () => {
    render(<TaskDetailPanel task={task} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveClass("max-w-[740px]", "left-1/2");
    expect(screen.getByRole("region", {name:"Переписка"})).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByText("Событие истории")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("Показать историю действий", {selector:"summary"}));
    expect(await screen.findByText("Событие истории")).toBeInTheDocument();
  });

  it("retains unsent message and description while opening and closing history", async () => {
    const onSave=vi.fn();
    render(<TaskDetailPanel task={task} onClose={vi.fn()} onSave={onSave}/>);
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,120));});
    const description=screen.getByRole("textbox",{name:"Описание для проверки"});
    const message=screen.getByRole("textbox",{name:"Черновик сообщения"});
    if (screen.queryByRole("button", {name:"Изменить описание"})) fireEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    fireEvent.change(description,{target:{value:"Описание ещё не отправлено"}});
    fireEvent.change(message,{target:{value:"Сообщение ещё не отправлено"}});
    const history=screen.getByText("Показать историю действий",{selector:"summary"});
    await userEvent.click(history);
    await screen.findByText("Событие истории");
    await userEvent.click(history);
    expect(screen.getByRole("textbox",{name:"Описание для проверки"})).toBe(description);
    expect(description).toHaveValue("Описание ещё не отправлено");
    expect(screen.getByRole("textbox",{name:"Черновик сообщения"})).toBe(message);
    expect(message).toHaveValue("Сообщение ещё не отправлено");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps the original opener across a task-key replacement and does not steal outside focus", () => {
    const onClose = vi.fn();
    function Example({ openedTask }: { openedTask: TaskType | null }) {
      return <>
        <button type="button">Инициатор</button>
        <button type="button">Внешнее действие</button>
        <TaskDetailPanel task={openedTask} onClose={onClose} onSave={vi.fn()} />
      </>;
    }
    const view = render(<Example openedTask={null} />);
    const opener = screen.getByRole("button", { name: "Инициатор" });
    opener.focus();
    view.rerender(<Example openedTask={task} />);
    expect(screen.getByRole("button", { name: "Закрыть окно" })).toHaveFocus();
    view.rerender(<Example openedTask={{ ...task, id: "replacement-task" }} />);
    expect(screen.getByRole("button", { name: "Закрыть окно" })).toHaveFocus();
    view.rerender(<Example openedTask={null} />);
    expect(opener).toHaveFocus();
    view.rerender(<Example openedTask={task} />);
    const outside = screen.getByRole("button", { name: "Внешнее действие" });
    outside.focus();
    view.rerender(<Example openedTask={null} />);
    expect(outside).toHaveFocus();
  });
});
