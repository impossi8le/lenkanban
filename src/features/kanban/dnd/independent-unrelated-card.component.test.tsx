import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KanbanDndBoard } from "./KanbanDndBoard";
import type { KanbanDndController } from "./use-kanban-dnd";
import type { KanbanBoardState } from "../model/types";
import type { MoveTaskResponse } from "../server/move-contract";

const observed = vi.hoisted(() => ({ current: null as KanbanDndController | null }));
vi.mock("./use-kanban-dnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-kanban-dnd")>();
  return { ...actual, useKanbanDnd: (options: Parameters<typeof actual.useKanbanDnd>[0]) => {
    const controller = actual.useKanbanDnd(options);
    observed.current = controller;
    return controller;
  } };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const snapshot: KanbanBoardState = {
  columnOrder: ["todo", "doing"],
  taskIdsByColumn: { todo: ["a", "b"], doing: [] },
  tasksById: Object.fromEntries(["a", "b"].map((id, index) => [id, {
    id, title: `Task ${id.toUpperCase()}`, columnId: "todo", position: 1024 * (index + 1),
    version: 1, priority: "MEDIUM", projectId: "project-1",
  }])),
};

describe("independent pending move navigation regression", () => {
  it("keeps both pending A and unrelated B openable while A transport is unsettled", async () => {
    let resolve!: (response: MoveTaskResponse) => void;
    const pending = new Promise<MoveTaskResponse>(yes => { resolve = yes; });
    const moveTask = vi.fn(() => pending);
    const onOpenTask = vi.fn();
    render(<StrictMode><KanbanDndBoard
      columns={[{ id: "todo", name: "Todo", color: "#aaa" }, { id: "doing", name: "Doing", color: "#bbb" }]}
      snapshot={snapshot} snapshotRevision={1} reorderEnabled moveClient={{ moveTask }}
      onCreateTask={vi.fn()} onOpenTask={onOpenTask} />
    </StrictMode>);
    let move!: Promise<MoveTaskResponse | null>;
    act(() => { move = observed.current!.moveTask({ taskId: "a", toColumnId: "doing", targetIndex: 0 }); });
    await waitFor(() => expect(moveTask).toHaveBeenCalledOnce());
    expect(observed.current!.pendingTaskIds).toEqual(new Set(["a"]));
    expect(screen.getByText("Task A").closest('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByText("Task B").closest('[aria-busy="true"]')).toBeNull();
    await userEvent.click(screen.getByText("Task B"));
    await userEvent.click(screen.getByText("Task A"));
    const openedDuringPending = onOpenTask.mock.calls.map(([task]) => task.id);
    expect(observed.current!.hasPendingMoves).toBe(true);
    await act(async () => {
      resolve({ operationId: "operation", boardRevision: 2,
        task: { id: "a", columnId: "doing", version: 2, status: "IN_PROGRESS" } });
      await move;
    });
    expect(openedDuringPending).toEqual(["b", "a"]);
    expect(observed.current!.pendingTaskIds.size).toBe(0);
    expect(observed.current!.hasPendingMoves).toBe(false);
  });
});
