import { useState } from "react";
import { DndContext } from "@dnd-kit/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KanbanColumn } from "./Column";
import { KanbanCardView, type TaskType } from "./Card";

const controls = vi.hoisted(() => ({ push: vi.fn(), dragStart: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: controls.push }) }));

const tasks: TaskType[] = ["Первое обращение", "Второе обращение"].map((title, index) => ({
  id: `task-${index}`, title, projectId: "project", columnId: "column",
  priority: "MEDIUM", position: 1024 * (index + 1),
}));

function SelectionColumn({ disabled = false }: { disabled?: boolean }) {
  const [selected, setSelected] = useState<string[]>([]);
  return <DndContext onDragStart={controls.dragStart}>
    <output aria-label="Выбранные ID">{selected.join(",")}</output>
    <KanbanColumn
      id="column" title="Очередь" color="#777777" tasks={tasks}
      onCreateTask={() => {}} selectedTaskIds={selected} selectionDisabled={disabled}
      onToggleTaskSelect={(id) => setSelected((previous) => previous.includes(id)
        ? previous.filter((value) => value !== id) : [...previous, id])}
    />
  </DndContext>;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it.each([false, true])("hides legacy selection even when selectionDisabled=%s", async disabled => {
  const user = userEvent.setup();
  render(<SelectionColumn disabled={disabled} />);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Выбранные ID")).toBeEmptyDOMElement();
  await user.click(screen.getByRole("button", { name: `Открыть задачу «${tasks[0].title}»` }));
  expect(controls.push).toHaveBeenCalledExactlyOnceWith("/projects/project/tasks/task-0");
  expect(controls.dragStart).not.toHaveBeenCalled();
});
it("opens a card from the keyboard without a drag handle or hidden selection side effects", async () => {
  const select = vi.fn(); const open = vi.fn();
  const { container } = render(<KanbanCardView task={{ ...tasks[0], createdAt: "2026-10-23T10:00:00Z" }} onTaskSelect={select} onOpen={open} />);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(container.querySelector("time")).toHaveAttribute("datetime", "2026-10-23T10:00:00.000Z");
  screen.getByRole("button", { name: `Открыть задачу «${tasks[0].title}»` }).focus();
  await userEvent.keyboard("{Enter}");
  expect(open).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
});
