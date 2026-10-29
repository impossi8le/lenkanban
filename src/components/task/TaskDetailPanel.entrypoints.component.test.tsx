import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";
import { TaskDetailPanel } from "./TaskDetailPanel";

vi.mock("@/components/task/TaskRelatedRequests", () => ({ TaskRelatedRequests: () => null }));

vi.mock("next/dynamic", () => ({
  default: (loader: () => unknown) => function DynamicStub(props: { content: string; onChange: (value: string) => void }) {
    return loader.toString().includes("RichTextEditor")
      ? <textarea aria-label="Описание для проверки" value={props.content} onChange={event => props.onChange(event.target.value)} />
      : null;
  },
}));
vi.mock("@/components/task/ActivityTimeline", () => ({ ActivityTimeline: () => null }));
vi.mock("@/components/task/TaskAttachments", () => ({ TaskAttachments: () => null }));
vi.mock("@/components/task/TaskChecklist", () => ({ TaskChecklist: () => null }));
vi.mock("@/components/task/TagPicker", () => ({ TagPicker: () => null }));
vi.mock("@/components/task/AssigneeSelector", () => ({ AssigneeSelector: () => null }));
vi.mock("@/components/task/TaskColumnSelector", () => ({ TaskColumnSelector: () => null }));
vi.mock("@/components/templates/TemplateDialog", () => ({ TemplateDialog: () => null }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "entry-user" } } }) }));

const task: TaskType = {
  id: "entry-task", title: "Задача с доски", description: "", status: "TODO",
  columnId: "todo", priority: "MEDIUM", position: 1024, projectId: "synthetic-project",
  assignees: [], tags: [], attachments: [], checklistItems: [],
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

describe("TaskDetailPanel entry points", () => {
  it("saves, closes and returns focus to the board card that opened it", async () => {
    const onSave = vi.fn();
    function Board() {
      const [opened, setOpened] = useState<TaskType | null>(null);
      return <>
        <div role="list" aria-label="Колонка TODO">
          <div role="listitem">
            <button type="button" onClick={() => setOpened(task)}>Открыть карточку задачи</button>
          </div>
        </div>
        <TaskDetailPanel task={opened} onClose={() => setOpened(null)} onSave={onSave} />
      </>;
    }
    render(<Board />);
    const card = screen.getByRole("button", { name: "Открыть карточку задачи" });
    card.focus();
    await userEvent.click(card);

    const dialog = await screen.findByRole("dialog", { name: "Детали обращения" });
    // Presence precedes the first animation frame under normal motion.
    await waitFor(() => expect(dialog).toBeVisible());
    expect(dialog.contains(document.activeElement)).toBe(true);

    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
    fireEvent.click(screen.getByRole("button", { name: "Изменить тему обращения" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Тема обращения" }), { target: { value: "Сохранённое название" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить название" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("entry-task", { title: "Сохранённое название" }, expect.anything()));

    await userEvent.click(screen.getByRole("button", { name: "Закрыть окно" }));
    expect(screen.queryByRole("dialog", { name: "Детали обращения" })).not.toBeInTheDocument();
    expect(card).toHaveFocus();
  });

  it("closes the direct-link panel with Escape and keeps outside focus when no card opened it", async () => {
    const onClose = vi.fn();
    render(<>
      <button type="button">Внешнее действие</button>
      <TaskDetailPanel task={task} onClose={onClose} onSave={vi.fn()} />
    </>);
    const outside = screen.getByRole("button", { name: "Внешнее действие" });
    // A direct link mounts the panel without an opener; the panel takes focus
    // for its own keyboard handling.
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Детали обращения" })).toBeVisible());
    expect(screen.getByRole("dialog", { name: "Детали обращения" }).contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    // Nothing outside the panel opened it, so its unmount must not move focus.
    expect(outside).not.toHaveFocus();
  });

  it("keeps the modal backdrop close path and the close button equivalent", async () => {
    const onClose = vi.fn();
    const view = render(<TaskDetailPanel task={task} onClose={onClose} onSave={vi.fn()} />);
    // The backdrop is the sibling of the dialog, not an element inside it.
    const backdrop = view.container.querySelector(".fixed.inset-0.z-40.bg-black\\/30") as HTMLElement;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Закрыть окно" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
