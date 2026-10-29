import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KanbanCard, type TaskType } from "./Card";

const controls = vi.hoisted(() => ({
  pointerDown: vi.fn(),
  keyDown: vi.fn(),
  activatorRef: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: controls.push }) }));
vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    setNodeRef: () => {},
    setActivatorNodeRef: controls.activatorRef,
    attributes: { role: "button", tabIndex: 0, "aria-roledescription": "sortable" },
    listeners: { onPointerDown: controls.pointerDown, onKeyDown: controls.keyDown },
    transform: null,
    transition: undefined,
    isDragging: false,
    rect: { current: { height: 150 } },
    active: null,
  }),
}));

const task: TaskType = {
  id: "task", title: "Проверить мобильную доску", projectId: "project",
  columnId: "column", position: 1024, priority: "MEDIUM",
  description: "Описание остаётся областью прокрутки",
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it.each([false, true])("exposes opening without sortable activators even when canMove=%s", canMove => {
  const { container } = render(<KanbanCard task={task} canMove={canMove} />);
  const root = container.firstElementChild as HTMLElement;
  const open = screen.getByRole("button", { name: `Открыть задачу «${task.title}»` });
  expect(root.style.touchAction).toBe("auto");
  expect(container.querySelector("[data-kanban-drag-handle]")).toBeNull();
  expect(screen.queryByRole("button", { name: /Переместить/ })).not.toBeInTheDocument();
  fireEvent.pointerDown(root);
  fireEvent.pointerDown(open);
  fireEvent.pointerDown(screen.getByText(task.description!));
  fireEvent.keyDown(open, { key: "Enter" });
  expect(controls.pointerDown).not.toHaveBeenCalled();
  expect(controls.keyDown).not.toHaveBeenCalled();
  expect(controls.activatorRef).not.toHaveBeenCalled();
  expect(controls.push).not.toHaveBeenCalled();
  fireEvent.click(open);
  expect(controls.push).toHaveBeenCalledExactlyOnceWith("/projects/project/tasks/task");
});
