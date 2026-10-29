import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KanbanDndBoard, type KanbanDndBoardProps } from "./KanbanDndBoard";
import type { KanbanBoardState } from "@/features/kanban/model/types";
import { DndContext } from "@dnd-kit/core";
import { KanbanColumn } from "@/components/kanban/Column";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);

const columns = [{ id: "todo", name: "Очередь", color: "#64748b" }];
const snapshot: KanbanBoardState = {
  columnOrder: ["todo"],
  taskIdsByColumn: { todo: ["a", "b"] },
  tasksById: {
    a: { id: "a", title: "Заявка A", columnId: "todo", position: 1024, version: 1, priority: "MEDIUM", projectId: "project-1" },
    b: { id: "b", title: "Заявка B", columnId: "todo", position: 2048, version: 1, priority: "HIGH", projectId: "project-1" },
  },
};

function Harness({ disabled = false, onOpen = vi.fn(), moveTask = vi.fn() }: {
  disabled?: boolean;
  onOpen?: KanbanDndBoardProps["onOpenTask"];
  moveTask?: NonNullable<KanbanDndBoardProps["moveClient"]>["moveTask"];
}) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  return <>
    <output aria-label="Выбрано задач">{selected.length}</output>
    <KanbanDndBoard
      columns={columns}
      snapshot={snapshot}
      snapshotRevision={1}
      reorderEnabled
      selectedTaskIds={selected}
      selectionDisabled={disabled}
      onToggleTaskSelect={(id) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}
      moveClient={{ moveTask }}
      onCreateTask={() => undefined}
      onOpenTask={onOpen}
    />
  </>;
}

describe("V2 board explicit selection", () => {
  it("disables dragging and removes move commands for an applicant", () => {
    render(<KanbanDndBoard columns={columns} snapshot={snapshot} snapshotRevision={1} reorderEnabled
      canChangeStatus={false} onCreateTask={vi.fn()} onOpenTask={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Переместить задачу «Заявка A»" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Действия.*Заявка A/ })).not.toBeInTheDocument();
  });
  it("offers applicant creation only in the permitted initial column", () => {
    render(<KanbanDndBoard columns={[...columns, { id: "work", name: "В работе", color: "#aaa" }]}
      snapshot={{ ...snapshot, columnOrder: ["todo", "work"], taskIdsByColumn: { ...snapshot.taskIdsByColumn, work: [] } }}
      allowedCreationColumnIds={["todo"]} snapshotRevision={1} reorderEnabled
      onCreateTask={vi.fn()} onOpenTask={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: /^Добавить обращение$/ })).toHaveLength(1);
  });

  it("hides legacy column creation and restores it when permitted", async () => {
    const create = vi.fn();
    const column = (canCreate: boolean) => <DndContext><KanbanColumn id="work" title="В работе" color="#aaa" tasks={[]} onCreateTask={create} canCreate={canCreate} /></DndContext>;
    const view = render(column(false));
    expect(screen.queryByRole("button", { name: "Добавить обращение" })).not.toBeInTheDocument();
    view.rerender(column(true));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Добавить обращение" }));
    expect(create).toHaveBeenCalledExactlyOnceWith({ title: "", columnId: "work" });
    expect(screen.queryByPlaceholderText("Название задачи…")).not.toBeInTheDocument();
  });

  it.each([false, true])("hides selection controls with pending=%s while preserving opening", async disabled => {
    const onOpen = vi.fn(); const moveTask = vi.fn();
    render(<Harness disabled={disabled} onOpen={onOpen} moveTask={moveTask} />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Выбрано задач")).toHaveTextContent("0");
    await userEvent.click(screen.getByRole("button", { name: "Открыть задачу «Заявка A»" }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen.mock.calls[0][0].id).toBe("a");
    expect(moveTask).not.toHaveBeenCalled();
  });
});
