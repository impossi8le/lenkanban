import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useDragDropManager, type DragEndEvent, type DragStartEvent } from "@dnd-kit/react";
import type { DragDropManager } from "@dnd-kit/dom";
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

const documentAnimations = Object.getOwnPropertyDescriptor(document, "getAnimations");
const elementAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
const elementAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [target, descriptor] of [[document, documentAnimations], [Element.prototype, elementAnimations]] as const) {
    if (descriptor) Object.defineProperty(target, "getAnimations", descriptor);
    else Reflect.deleteProperty(target, "getAnimations");
  }
  if (elementAnimate) Object.defineProperty(Element.prototype, "animate", elementAnimate);
  else Reflect.deleteProperty(Element.prototype, "animate");
});
const snapshot: KanbanBoardState = {
  columnOrder: ["todo", "doing"],
  taskIdsByColumn: { todo: ["a"], doing: [] },
  tasksById: { a: { id: "a", title: "Заявка A", columnId: "todo", position: 1024,
    version: 1, priority: "MEDIUM", projectId: "project-1" } },
};
const source = { id: "a", type: "task", initialGroup: "todo", group: "todo", initialIndex: 0, index: 0 };
const start = { operation: { source, target: null } } as unknown as DragStartEvent;
function end(canceled = false, group = "todo"): DragEndEvent {
  return { canceled, operation: { source: { ...source, group }, target: { id: group, type: "column", data: { columnId: group } } } } as unknown as DragEndEvent;
}
function deferred() {
  let resolve!: (response: MoveTaskResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<MoveTaskResponse>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(columnId = "doing", version = 2): MoveTaskResponse {
  return { operationId: "operation", boardRevision: version,
    task: { id: "a", columnId, version, status: "IN_PROGRESS" } };
}
function mount(moveTask = vi.fn(async () => response())) {
  let manager!: DragDropManager;
  const onOpenTask = vi.fn();
  function Probe() { manager = useDragDropManager()!; return null; }
  const board = (state: KanbanBoardState) => <StrictMode><KanbanDndBoard
    columns={[{ id: "todo", name: "Очередь", color: "#aaa" }, { id: "doing", name: "В работе", color: "#bbb" }]}
    snapshot={state} snapshotRevision={1} reorderEnabled moveClient={{ moveTask }}
    onCreateTask={vi.fn()} onOpenTask={onOpenTask} afterColumns={<Probe />} />
  </StrictMode>;
  const view = render(board(snapshot));
  return { onOpenTask, moveTask, manager: () => manager,
    regenerate: () => view.rerender(board(structuredClone(snapshot))) };
}
function expectSettled() {
  expect(observed.current!.pendingTaskIds.size).toBe(0);
  expect(observed.current!.hasPendingMoves).toBe(false);
  expect(observed.current!.isDragging).toBe(false);
}
async function openCard() {
  // Pending cards use the root open surface; settled cards have a separate button.
  await userEvent.click(screen.getByText("Заявка A"));
}

describe("issue 99 drag completion and pending moves", () => {
  it("opens on the first click without exposing a drag handle", async () => {
    const view = mount();
    expect(screen.queryByRole("button", { name: /Переместить задачу/ })).not.toBeInTheDocument();
    await openCard();
    expectSettled();
    expect(view.onOpenTask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "a" }));
    expect(view.moveTask).not.toHaveBeenCalled();
  });

  it.each([false, true])("clears started drag after no-op/cancel (canceled=%s), including a deferred snapshot", async canceled => {
    const view = mount();
    act(() => view.manager().monitor.dispatch("dragstart", start));
    expect(observed.current!.isDragging).toBe(true);
    view.regenerate();
    act(() => view.manager().monitor.dispatch("dragend", end(canceled)));
    expectSettled();
    expect(observed.current!.state.taskIdsByColumn).toEqual(snapshot.taskIdsByColumn);
    await openCard();
    expect(view.onOpenTask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "a" }));
    expect(view.moveTask).not.toHaveBeenCalled();
  });

  it.each(["{Enter}", " "])("opens from native keyboard activation %s without starting a manual move", async key => {
    const view = mount();
    screen.getByRole("button", { name: "Открыть задачу «Заявка A»" }).focus();
    await userEvent.keyboard(key);
    expectSettled();
    expect(view.onOpenTask).toHaveBeenCalledOnce();
    expect(view.moveTask).not.toHaveBeenCalled();
    expect(observed.current!.state.taskIdsByColumn).toEqual(snapshot.taskIdsByColumn);
  });

  it("restores the drag snapshot and opening when drop planning throws", async () => {
    const view = mount();
    act(() => view.manager().monitor.dispatch("dragstart", start));
    expect(observed.current!.isDragging).toBe(true);
    act(() => {
      expect(() => observed.current!.handlers.onDragEnd!(end(false, "missing"), view.manager())).toThrow();
    });
    expectSettled();
    expect(observed.current!.state.taskIdsByColumn).toEqual(snapshot.taskIdsByColumn);
    expect(view.moveTask).not.toHaveBeenCalled();
    await openCard();
    expect(view.onOpenTask).toHaveBeenCalledOnce();
  });

  it.each([false, true])("keeps a pending card openable until a real move settles (failure=%s)", async failure => {
    const pending = deferred();
    const view = mount(vi.fn(() => pending.promise));
    act(() => view.manager().monitor.dispatch("dragstart", start));
    act(() => view.manager().monitor.dispatch("dragend", end(false, "doing")));
    await waitFor(() => expect(view.moveTask).toHaveBeenCalledOnce());
    expect(observed.current!.pendingTaskIds).toEqual(new Set(["a"]));
    expect(observed.current!.state.taskIdsByColumn.doing).toEqual(["a"]);
    expect(screen.getByText("Заявка A").closest('[aria-busy="true"]')).not.toBeNull();
    await openCard();
    expect(view.onOpenTask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "a" }));
    await act(async () => {
      if (failure) pending.reject(new Error("move failed"));
      else pending.resolve(response());
    });
    expectSettled();
    expect(observed.current!.state.taskIdsByColumn[failure ? "todo" : "doing"]).toEqual(["a"]);
    await openCard();
    expect(view.onOpenTask).toHaveBeenCalledTimes(2);
  });

  it("keeps the same task pending until every queued move settles", async () => {
    const first = deferred();
    const second = deferred();
    const client = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mount(client);
    let firstMove!: Promise<MoveTaskResponse | null>;
    let secondMove!: Promise<MoveTaskResponse | null>;
    act(() => {
      firstMove = observed.current!.moveTask({ taskId: "a", toColumnId: "doing", targetIndex: 0 });
      secondMove = observed.current!.moveTask({ taskId: "a", toColumnId: "todo", targetIndex: 0 });
    });
    await act(async () => { first.resolve(response()); await firstMove; });
    expect(observed.current!.pendingTaskIds).toEqual(new Set(["a"]));
    expect(observed.current!.hasPendingMoves).toBe(true);
    await act(async () => { second.resolve(response("todo", 3)); await secondMove; });
    expectSettled();
  });

  it("releases pending and rolls back when the move client throws synchronously", async () => {
    const error = new Error("synchronous failure");
    const view = mount(vi.fn(() => { throw error; }));
    let move!: Promise<MoveTaskResponse | null>;
    await act(async () => {
      move = observed.current!.moveTask({ taskId: "a", toColumnId: "doing", targetIndex: 0 });
      await expect(move).rejects.toBe(error);
    });
    expectSettled();
    expect(observed.current!.state.taskIdsByColumn).toEqual(snapshot.taskIdsByColumn);
    await openCard();
    expect(view.onOpenTask).toHaveBeenCalledOnce();
  });

  it("leaves no pending operation when planning fails or a direct move is a no-op", async () => {
    const view = mount();
    await act(async () => {
      await expect(observed.current!.moveTask({ taskId: "a", toColumnId: "todo", targetIndex: 0 })).resolves.toBeNull();
      await expect(observed.current!.moveTask({ taskId: "a", toColumnId: "missing", targetIndex: 0 })).rejects.toThrow();
    });
    expectSettled();
    expect(observed.current!.state.taskIdsByColumn).toEqual(snapshot.taskIdsByColumn);
    expect(view.moveTask).not.toHaveBeenCalled();
    await openCard();
    expect(view.onOpenTask).toHaveBeenCalledOnce();
  });
});
