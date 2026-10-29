import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";
import { TaskDetailPanel } from "./TaskDetailPanel";

vi.mock("@/components/task/TaskRelatedRequests", () => ({ TaskRelatedRequests: () => null }));

vi.mock("next/dynamic", async () => {
  const { Calendar } = await import("@/components/ui/calendar");
  return {
  default: (loader: () => unknown) => loader.toString().includes("ui/calendar") ? Calendar : function DynamicStub(props: { content: string; onChange: (value: string) => void }) {
    const [message, setMessage] = useState("");
    return loader.toString().includes("RichTextEditor")
      ? <textarea aria-label="Описание для проверки" value={props.content} onChange={event => props.onChange(event.target.value)} />
      : <textarea aria-label="Черновик сообщения" value={message} onChange={event => setMessage(event.target.value)} />;
  },
};
});
vi.mock("@/components/task/ActivityTimeline", () => ({ ActivityTimeline: () => <p>Событие истории</p> }));
vi.mock("@/components/task/TaskAttachments", () => ({ TaskAttachments: () => null }));
vi.mock("@/components/task/TaskChecklist", () => ({ TaskChecklist: () => null }));
vi.mock("@/components/task/TagPicker", () => ({ TagPicker: () => null }));
vi.mock("@/components/task/AssigneeSelector", () => ({ AssigneeSelector: () => null }));
vi.mock("@/components/task/TaskColumnSelector", () => ({ TaskColumnSelector: () => null }));
vi.mock("@/components/templates/TemplateDialog", () => ({ TemplateDialog: () => null }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "mobile-user" } } }) }));

const longTitle = "Очень длинное название задачи, которое не должно раздвигать шапку карточки на узком экране";
const longAssignee = "Александра-Екатерина-Константинопольская-Очень-Длинная-Фамилия";
const longTag = "срочно-клиент-жалуется-на-повторяющуюся-ошибку-интеграции";

function makeTask(overrides: Partial<TaskType> = {}): TaskType {
  return {
    id: "mobile-task-0123456789abcdef",
    title: longTitle,
    description: "",
    status: "TODO",
    columnId: "todo",
    priority: "MEDIUM",
    position: 1024,
    projectId: "synthetic-project",
    assignees: [{ id: "assignment", user: { id: "mobile-user", name: "User", email: "user@example.invalid" } }],
    tags: [],
    attachments: [],
    checklistItems: [],
    ...overrides,
  };
}

function renderPanel(task: TaskType, onSave = vi.fn()) {
  const view = render(<TaskDetailPanel task={task} onClose={vi.fn()} onSave={onSave} />);
  return { ...view, onSave };
}

beforeEach(() => {
  // Radix scrolls the active option; jsdom has no layout implementation.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  vi.stubGlobal("localStorage", frame.contentWindow!.localStorage);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "visualViewport");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  document.querySelectorAll("iframe").forEach(frame => frame.remove());
});

describe("TaskDetailPanel at 320px", () => {
  it("keeps the header to ID, a truncated title and fixed actions", () => {
    renderPanel(makeTask());
    const header = screen.getByRole("group", { name: "Шапка карточки" });
    expect(header).toHaveClass("min-w-0", "shrink-0", "px-3", "pt-[env(safe-area-inset-top)]");

    // The identifier must be allowed to shrink, otherwise three action buttons
    // plus the ID overflow a 320px viewport.
    expect(screen.queryByText(/^#/)).not.toBeInTheDocument();

    const title = screen.getByTestId("task-header-title");
    expect(title).toHaveTextContent("Обращение");
    expect(title).toHaveAttribute("title", "Обращение");
    expect(title).toHaveClass("min-w-0", "truncate");

    const actions = screen.getByRole("group", { name: "Действия с задачей" });
    expect(actions).toHaveClass("shrink-0");
    for (const name of ["Закрыть окно"]) {
      expect(within(actions).getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("stacks property fields, assignees and tags with wrapping chips", () => {
    const { container } = renderPanel(makeTask({
      assignees: [{ id: "assignment-1", user: { id: "user-1", name: longAssignee, email: "long@example.invalid" } }],
      tags: [{ id: "task-tag-1", tag: { id: "tag-1", name: longTag, color: "#ef4444" } }],
    }));

    // Auto-fit grids fall back to one column below the minimum track width.
    const propertyGrid = container.querySelector(".grid.grid-cols-\\[repeat\\(auto-fit\\,minmax\\(min\\(100\\%\\,11rem\\)\\,1fr\\)\\)\\]");
    expect(propertyGrid).not.toBeNull();
    expect(propertyGrid).toHaveClass("min-w-0");
    const peopleGrid = container.querySelector(".grid.grid-cols-\\[repeat\\(auto-fit\\,minmax\\(min\\(100\\%\\,14rem\\)\\,1fr\\)\\)\\]");
    expect(peopleGrid).not.toBeNull();
    expect(peopleGrid).toHaveClass("min-w-0");

    const assigneeChip = screen.getAllByText(longAssignee).find(element => element.className.includes("[overflow-wrap:anywhere]"))!;
    expect(assigneeChip).toHaveClass("min-w-0", "[overflow-wrap:anywhere]");
    expect(assigneeChip.parentElement).toHaveClass("min-w-0", "max-w-full");

    expect(screen.queryByText(longTag)).not.toBeInTheDocument();

    // The title input keeps its own min-w-0 so a long value scrolls inside it.
    expect(screen.getByRole("textbox", { name: "Тема обращения" })).toHaveClass("min-w-0", "flex-1");
  });

  it("clips the description editor so a wide toolbar cannot widen the panel", async () => {
    renderPanel(makeTask());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });

    await userEvent.click(screen.getByRole("button", {name:"Изменить описание"}));
    const descriptionField = screen.getByRole("textbox", { name: "Описание для проверки" });
    const wrapper = descriptionField.parentElement as HTMLElement;
    // The editor is a third-party (#50) surface: the panel constrains it rather
    // than editing src/components/editor/**.
    expect(wrapper).toHaveClass("min-w-0", "overflow-hidden", "[&_.ProseMirror]:[overflow-wrap:anywhere]");
    expect(wrapper.parentElement).toHaveClass("space-y-3");
    expect(wrapper.closest(".overflow-y-auto")).toHaveClass("min-w-0", "min-h-0");
  });

  it("keeps one centered request flow with inline discussion and collapsed history", async () => {
    renderPanel(makeTask());
    expect(screen.getByRole("dialog")).toHaveClass("max-w-[740px]", "w-[calc(100%-1.5rem)]");
    expect(screen.getByRole("region",{name:"Описание и свойства задачи"})).toHaveClass("min-w-0");
    expect(screen.getByRole("region",{name:"Переписка"})).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByText("Событие истории")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("Показать историю действий",{selector:"summary"}));
    expect(await screen.findByText("Событие истории")).toBeInTheDocument();
  });

  it("fits the panel to the visual viewport while the on-screen keyboard is open", () => {
    const listeners = new Set<() => void>();
    const viewport = {
      height: 420,
      scale: 1,
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === "resize") listeners.add(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === "resize") listeners.delete(listener);
      }),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });

    renderPanel(makeTask());
    const dialog = screen.getByRole("dialog", { name: "Детали обращения" });
    expect(dialog).toHaveClass("max-h-[calc(100dvh-2rem)]");
    expect(dialog).toHaveStyle({ maxHeight: "388px" });

    viewport.height = 300;
    act(() => listeners.forEach(listener => listener()));
    expect(dialog).toHaveStyle({ maxHeight: "268px" });

    // Pinch zoom must not be mistaken for an on-screen keyboard.
    viewport.scale = 2;
    act(() => listeners.forEach(listener => listener()));
    expect(dialog).toHaveClass("max-h-[calc(100dvh-2rem)]");
    expect(dialog.style.maxHeight).toBe("");
  });

  it("fits the date calendar in the viewport and changes priority with the keyboard", async () => {
    const { onSave } = renderPanel(makeTask({ priority: "HIGH" }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });

    await userEvent.click(screen.getByRole("button", { name: "Установить" }));
    const calendarDialog = screen.getAllByRole("dialog").find(dialog => dialog !== screen.getByRole("dialog", { name: "Детали обращения" }));
    expect(calendarDialog).toBeDefined();
    expect(calendarDialog).toHaveClass("max-w-[calc(100vw-1rem)]", "max-h-[var(--radix-popover-content-available-height)]", "overflow-y-auto");
    expect(calendarDialog).toContainElement(document.activeElement as HTMLElement);
    const grid = within(calendarDialog!).getByRole("grid");
    const day = within(grid).getAllByRole("button").find(button => button.textContent === "15");
    expect(day).toBeDefined();
    day!.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).not.toBe(day);
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(calendarDialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));

    const priority = screen.getByRole("combobox");
    expect(priority).toHaveTextContent("Срочно");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(priority, { key: "ArrowDown" });
    const listbox = await screen.findByRole("listbox");
    expect(listbox).toHaveClass("max-w-[calc(100vw-1rem)]", "max-h-[var(--radix-select-content-available-height)]");
    expect(within(listbox).getAllByRole("option")).toHaveLength(2);
    fireEvent.click(within(listbox).getByRole("option", { name: "Не срочно" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("mobile-task-0123456789abcdef", { title: longTitle, priority: "LOW" }, { onSuccess: expect.any(Function), onError: expect.any(Function) }));
  });
});
