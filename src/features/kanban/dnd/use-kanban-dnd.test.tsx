// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DragDropProvider,
} from "@dnd-kit/react";
import type {
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/react";
import {
  DragDropManager,
  PointerActivationConstraints,
} from "@dnd-kit/dom";
import { OptimisticSortingPlugin } from "@dnd-kit/dom/sortable";
import { CollisionPriority } from "@dnd-kit/abstract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";
import { KanbanDndColumn } from "@/components/kanban/Column";
import {
  requestCanonicalTaskMovedRefresh,
  shouldApplyTaskMovedSnapshot,
  shouldApplyTaskVersionSnapshot,
} from "@/hooks/useProjectBoard";
import type { KanbanBoardState } from "@/features/kanban/model/types";
import type {
  MoveTaskRequest,
  MoveTaskResponse,
} from "@/features/kanban/server/move-contract";
import { announceMoveUnchanged } from "@/features/kanban/accessibility/move-announcements";
import { KanbanCardOverlay } from "@/features/kanban/dnd/KanbanCardOverlay";
import {
  KanbanDndBoard,
  kanbanAccessibilityPlugins,
} from "@/features/kanban/dnd/KanbanDndBoard";
import { SortableKanbanCard } from "@/features/kanban/dnd/SortableKanbanCard";
import {
  type KanbanDndController,
  type KanbanMoveClient,
  type KanbanPointerMoveSettlement,
  getKanbanPointerActivationConstraints,
  isTaskReorderEnabled,
  preventKanbanPointerActivation,
  useKanbanDnd,
} from "@/features/kanban/dnd/use-kanban-dnd";

it.each([true, false])("keeps lift stable until a semantic keyboard move, then announces return and completion (cancel=%s)", async canceled => {
  const manager = new DragDropManager({ plugins: kanbanAccessibilityPlugins });
  render(<DragDropProvider manager={manager} plugins={kanbanAccessibilityPlugins}>
    <SortableKanbanCard task={{ id:"probe",title:"Keyboard task",columnId:"todo",priority:"MEDIUM",projectId:"project",position:1 }} index={1} columnId="todo" columnTitle="К выполнению" reorderEnabled />
  </DragDropProvider>);
  await waitFor(() => { expect(screen.getByRole("status")).toBeInTheDocument(); expect([...manager.registry.draggables]).toHaveLength(1); });
  const source = [...manager.registry.draggables][0];
  manager.dragOperation.activatorEvent = new KeyboardEvent("keydown", { key: " " });
  const over = (position: number) => {
    const destination = { ...source, index: position, initialIndex: 1, data: source.data };
    manager.monitor.dispatch("dragover", { operation: { source: destination, target: destination } } as unknown as DragOverEvent);
  };
  act(() => {
    manager.monitor.dispatch("dragstart", { operation: { source, target: source } } as unknown as DragStartEvent);
    over(1); over(1);
  });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Поднята задача «Keyboard task» из колонки «К выполнению», позиция 2."));
  act(() => over(0));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Текущая позиция задачи «Keyboard task» — колонка «К выполнению», позиция 1."));
  act(() => { over(0); over(1); });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Текущая позиция задачи «Keyboard task» — колонка «К выполнению», позиция 2."));
  act(() => { manager.monitor.dispatch("dragover", { operation: { source, target: null } } as DragOverEvent); });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("находится вне колонок"));
  act(() => over(1));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Текущая позиция задачи «Keyboard task» — колонка «К выполнению», позиция 2."));
  act(() => { manager.monitor.dispatch("dragend", { canceled, operation: { source, target: source } } as unknown as DragEndEvent); });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(canceled ? "Перемещение задачи «Keyboard task» отменено. Задача возвращена на исходную позицию." : "Перемещение задачи «Keyboard task» обрабатывается."));
  act(() => {
    manager.monitor.dispatch("dragstart", { operation: { source, target: source } } as unknown as DragStartEvent);
    over(1);
  });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Поднята задача «Keyboard task» из колонки «К выполнению», позиция 2."));
});

const initialState: KanbanBoardState = {
  columnOrder: ["todo", "doing", "done"],
  taskIdsByColumn: {
    todo: ["a", "b", "c"],
    doing: ["d"],
    done: [],
  },
  tasksById: {
    a: {
      id: "a",
      columnId: "todo",
      position: 1024,
      version: 1,
      title: "Задача A",
    },
    b: {
      id: "b",
      columnId: "todo",
      position: 2048,
      version: 1,
      title: "Задача B",
    },
    c: {
      id: "c",
      columnId: "todo",
      position: 3072,
      version: 2,
      title: "Задача C",
    },
    d: {
      id: "d",
      columnId: "doing",
      position: 1024,
      version: 4,
      title: "Задача D",
    },
  },
};

const taskC: TaskType = {
  id: "c",
  title: "Задача C",
  columnId: "todo",
  priority: "MEDIUM",
  position: 3072,
  projectId: "project-1",
  version: 2,
};

const taskD: TaskType = {
  id: "d",
  title: "Задача D",
  columnId: "done",
  priority: "HIGH",
  position: 1024,
  projectId: "project-1",
  version: 4,
};

interface RecordedRequest {
  taskId: string;
  request: MoveTaskRequest;
}

class RecordingMoveClient implements KanbanMoveClient {
  readonly requests: RecordedRequest[] = [];

  constructor(
    private readonly run: (
      input: RecordedRequest,
    ) => Promise<MoveTaskResponse> = async ({ taskId, request }) => ({
      operationId: request.operationId,
      boardRevision: 2,
      task: {
        id: taskId,
        columnId: request.toColumnId,
        version: 3,
        status: "IN_PROGRESS",
      },
    }),
  ) {}

  moveTask(taskId: string, request: MoveTaskRequest): Promise<MoveTaskResponse> {
    const input = { taskId, request };
    this.requests.push(input);
    return this.run(input);
  }
}

interface HarnessProps {
  snapshot: KanbanBoardState;
  snapshotRevision?: number;
  moveClient: KanbanMoveClient;
  createOperationId?: () => string;
  onMoveError?: (error: unknown) => void;
  onMoveConfirmed?: (response: MoveTaskResponse) => void;
  onPointerMoveSettled?: (settlement: KanbanPointerMoveSettlement) => void;
  expose(controller: KanbanDndController): void;
}

function DndHarness({
  snapshot,
  snapshotRevision = 1,
  moveClient,
  createOperationId,
  onMoveError,
  onMoveConfirmed,
  onPointerMoveSettled,
  expose,
}: HarnessProps) {
  const controller = useKanbanDnd({
    snapshot,
    snapshotRevision,
    moveClient,
    createOperationId,
    onMoveError,
    onMoveConfirmed,
    onPointerMoveSettled,
  });

  expose(controller);

  return (
    <>
      <output data-testid="board-state">{JSON.stringify(controller.state)}</output>
      <output data-testid="dragging">{String(controller.isDragging)}</output>
      <output data-testid="pending">{String(controller.hasPendingMoves)}</output>
    </>
  );
}

function readState(): KanbanBoardState {
  return JSON.parse(screen.getByTestId("board-state").textContent ?? "{}") as KanbanBoardState;
}

function dragStartEvent(input: {
  taskId: string;
  initialIndex: number;
  initialGroup: string;
}): DragStartEvent {
  return {
    operation: {
      source: {
        id: input.taskId,
        type: "task",
        initialIndex: input.initialIndex,
        index: input.initialIndex,
        initialGroup: input.initialGroup,
        group: input.initialGroup,
      },
      target: null,
    },
  } as unknown as DragStartEvent;
}

function dragEndEvent(input: {
  taskId: string;
  initialIndex: number;
  index: number;
  initialGroup: string;
  group: string;
  target?: {
    id: string;
    type: string;
    data?: Record<string, unknown>;
  };
  canceled?: boolean;
  outside?: boolean;
  nativeEvent?: Event;
}): DragEndEvent {
  return {
    canceled: input.canceled ?? false,
    nativeEvent: input.nativeEvent,
    operation: {
      source: {
        id: input.taskId,
        type: "task",
        initialIndex: input.initialIndex,
        index: input.index,
        initialGroup: input.initialGroup,
        group: input.group,
      },
      target: input.outside
        ? null
        : (input.target ?? { id: `target-${input.group}`, type: "task" }),
    },
    suspend: () => ({
      resume: vi.fn(),
      abort: vi.fn(),
    }),
  } as unknown as DragEndEvent;
}

interface RenderHarnessOptions {
  onExpose?: (controller: KanbanDndController) => void;
  createOperationId?: () => string;
  onMoveError?: (error: unknown) => void;
  onMoveConfirmed?: (response: MoveTaskResponse) => void;
  onPointerMoveSettled?: (settlement: KanbanPointerMoveSettlement) => void;
}

function renderHarness(
  moveClient: KanbanMoveClient,
  snapshot: KanbanBoardState = structuredClone(initialState),
  options: RenderHarnessOptions = {},
) {
  let controller!: KanbanDndController;
  const expose = (value: KanbanDndController) => {
    controller = value;
    options.onExpose?.(value);
  };
  const view = render(
    <DndHarness
      snapshot={snapshot}
      moveClient={moveClient}
      createOperationId={options.createOperationId}
      onMoveError={options.onMoveError}
      onMoveConfirmed={options.onMoveConfirmed}
      onPointerMoveSettled={options.onPointerMoveSettled}
      expose={expose}
    />,
  );

  return {
    ...view,
    controller: () => controller,
    rerenderSnapshot(nextSnapshot: KanbanBoardState, snapshotRevision = 1) {
      view.rerender(
        <DndHarness
          snapshot={nextSnapshot}
          snapshotRevision={snapshotRevision}
          moveClient={moveClient}
          createOperationId={options.createOperationId}
          onMoveError={options.onMoveError}
          onMoveConfirmed={options.onMoveConfirmed}
          onPointerMoveSettled={options.onPointerMoveSettled}
          expose={expose}
        />,
      );
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("modern task card registration", () => {
  it.each([false, true])("keeps a drag-disabled card available for pointer and keyboard opening (pending=%s)", async (isPending) => {
    const manager = new DragDropManager({ plugins: kanbanAccessibilityPlugins });
    const onOpen = vi.fn();
    render(<DragDropProvider manager={manager} plugins={kanbanAccessibilityPlugins}>
      <SortableKanbanCard task={taskC} index={2} columnId="todo" columnTitle="К выполнению"
        reorderEnabled={false} isPending={isPending} onOpen={onOpen} />
    </DragDropProvider>);
    // Let real dnd-kit accessibility effects settle before checking the open surface.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    const card = screen.getByRole("button", { name: `Открыть задачу «${taskC.title}»` });
    const wrapper = screen.getByTestId("kanban-sortable-card");
    expect(card.tagName).toBe("BUTTON");
    expect(card).toBeEnabled();
    expect(card.closest('[aria-disabled="true"]')).toBeNull();
    expect(wrapper).not.toHaveAttribute("role", "button");
    expect(screen.queryByRole("button", { name: `Переместить задачу «${taskC.title}»` })).not.toBeInTheDocument();
    await userEvent.click(screen.getByText(taskC.title));
    card.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect([...manager.registry.draggables]).toHaveLength(0);
  });

  it("keeps pending sortable drag disabled while its separate task-open button works", async () => {
    const manager = new DragDropManager({ plugins: kanbanAccessibilityPlugins });
    const onOpen = vi.fn();
    render(<DragDropProvider manager={manager} plugins={kanbanAccessibilityPlugins}>
      <SortableKanbanCard task={taskC} index={2} columnId="todo" columnTitle="К выполнению"
        reorderEnabled isPending onOpen={onOpen} />
    </DragDropProvider>);
    expect(screen.queryByRole("button", { name: /Переместить задачу/ })).not.toBeInTheDocument();
    const open = screen.getByRole("button", { name: `Открыть задачу «${taskC.title}»` });
    expect(open.closest('[aria-disabled="true"]')).toBeNull();
    await userEvent.click(open);
    open.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect([...manager.registry.draggables]).toHaveLength(1);
  });

  it("registers the task once while the overlay stays presentation-only", async () => {
    const manager = new DragDropManager();

    render(
      <DragDropProvider manager={manager}>
        <SortableKanbanCard
          task={taskC}
          index={2}
          columnId="todo"
          columnTitle="К выполнению"
          reorderEnabled
        />
        <aside data-testid="overlay">
          <KanbanCardOverlay task={taskC} />
        </aside>
      </DragDropProvider>,
    );

    await waitFor(() => {
      expect([...manager.registry.draggables]).toHaveLength(1);
      expect([...manager.registry.droppables]).toHaveLength(1);
    });

    const [source] = [...manager.registry.draggables];
    expect(source).toMatchObject({
      id: "c",
      type: "task",
      index: 2,
      group: "todo",
    });
    expect(screen.queryByRole("button", { name: /Переместить задачу/ })).not.toBeInTheDocument();
    expect(
      manager.plugins.some(
        (plugin) => plugin instanceof OptimisticSortingPlugin,
      ),
    ).toBe(false);
    expect(
      within(screen.getByTestId("overlay")).queryByTestId("kanban-sortable-card"),
    ).not.toBeInTheDocument();
  });

  it("keeps an empty column reachable at lower collision priority", async () => {
    const manager = new DragDropManager();

    render(
      <DragDropProvider manager={manager}>
        <KanbanDndColumn
          id="done"
          title="Готово"
          color="#22c55e"
          tasks={[]}
          reorderEnabled
          pendingTaskIds={new Set()}
          onCreateTask={vi.fn()}
        />
      </DragDropProvider>,
    );

    await waitFor(() => {
      expect([...manager.registry.droppables]).toHaveLength(1);
    });
    expect([...manager.registry.droppables][0]).toMatchObject({
      id: "done",
      type: "column",
      accept: "task",
      collisionPriority: CollisionPriority.Low,
    });
    expect(screen.getByText("Готово")).toBeInTheDocument();
    expect(
      document.querySelector(
        '[data-column-id="done"] [data-kanban-column-scroll]',
      ),
    ).toBeInTheDocument();
  });

  it("opens from title and body surfaces without a drag handle", async () => {
    const onOpen = vi.fn();
    render(<DragDropProvider><SortableKanbanCard
      task={{ ...taskC, description: "Описание задачи", _count: { messages: 2 } }}
      index={2} columnId="todo" columnTitle="К выполнению" reorderEnabled={false} onOpen={onOpen}
    /></DragDropProvider>);
    expect(screen.queryByRole("button", { name: /Переместить задачу/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Описание задачи"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const open = screen.getByRole("button", { name: "Открыть задачу «Задача C»" });
    await userEvent.click(open);
    open.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("announces transient drag state without claiming persistence before the request settles", async () => {
    const manager = new DragDropManager({
      plugins: kanbanAccessibilityPlugins,
    });

    render(
      <DragDropProvider
        manager={manager}
        plugins={kanbanAccessibilityPlugins}
      >
        <SortableKanbanCard
          task={taskC}
          index={2}
          columnId="todo"
          columnTitle="К выполнению"
          reorderEnabled
        />
        <KanbanDndColumn
          id="done"
          title="Готово"
          color="#22c55e"
          tasks={[taskD]}
          reorderEnabled
          pendingTaskIds={new Set()}
          onCreateTask={vi.fn()}
          onOpenTask={vi.fn()}
        />
      </DragDropProvider>,
    );

    await waitFor(() => {
      expect(document.body).toHaveTextContent(
        "Чтобы взять задачу, нажмите пробел или Enter",
      );
      expect([...manager.registry.draggables]).toHaveLength(2);
      expect([...manager.registry.droppables]).toHaveLength(3);
    });
    const source = [...manager.registry.draggables].find(
      (draggable) => draggable.id === "c",
    );
    const target = [...manager.registry.droppables].find(
      (droppable) => droppable.type === "column",
    );
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    manager.dragOperation.activatorEvent = new Event("pointerdown");

    act(() => {
      manager.monitor.dispatch("dragstart", {
        operation: { source, target: null },
      } as DragStartEvent);
    });
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Поднята задача «Задача C» из колонки «К выполнению», позиция 3.",
      );
    });

    act(() => {
      manager.monitor.dispatch("dragover", {
        operation: { source, target },
      } as DragOverEvent);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "Текущая позиция задачи",
    );

    act(() => {
      manager.monitor.dispatch("dragend", {
        canceled: false,
        operation: { source, target },
      } as DragEndEvent);
    });
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Перемещение задачи «Задача C» обрабатывается.",
      );
    });
    expect(screen.getByRole("status")).not.toHaveTextContent(
      /размещена|сохранено|успешно/i,
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(
      /todo|done|target-/i,
    );

    act(() => {
      manager.monitor.dispatch("dragend", {
        canceled: true,
        operation: {
          source,
          target,
        },
      } as DragEndEvent);
    });
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Перемещение задачи «Задача C» отменено. Задача возвращена на исходную позицию.",
      );
    });
    });
  });

  it("keeps dragend neutral when dnd-kit recenters mutated sortable metadata", async () => {
    const manager = new DragDropManager({
      plugins: kanbanAccessibilityPlugins,
    });
    render(
      <DragDropProvider
        manager={manager}
        plugins={kanbanAccessibilityPlugins}
      >
        <SortableKanbanCard
          task={taskC}
          index={2}
          columnId="todo"
          columnTitle="К выполнению"
          reorderEnabled
        />
      </DragDropProvider>,
    );

    // Registration precedes the accessibility plugin's scheduled DOM setup.
    // Dispatch synthetic events only once its live region can receive them.
    await waitFor(() => {
      expect(document.body).toHaveTextContent(
        "Чтобы взять задачу, нажмите пробел или Enter",
      );
      expect(screen.getByRole("status")).toBeInTheDocument();
      expect([...manager.registry.draggables]).toHaveLength(1);
    });
    const registeredSource = [...manager.registry.draggables][0];
    const recenteredSource = {
      ...registeredSource,
      initialIndex: 0,
      index: 0,
      initialGroup: "done",
      group: "done",
      data: {
        ...registeredSource.data,
        columnId: "done",
        columnTitle: "Готово",
      },
    };

    act(() => {
      manager.monitor.dispatch("dragstart", {
        operation: {
          source: registeredSource,
          target: null,
        },
      } as DragStartEvent);
      manager.monitor.dispatch("dragend", {
        canceled: false,
        operation: {
          source: recenteredSource,
          target: recenteredSource,
        },
      } as unknown as DragEndEvent);
    });

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Перемещение задачи «Задача C» обрабатывается.",
      );
    });
    expect(screen.getByRole("status")).not.toHaveTextContent(
      /осталась на прежнем месте|сохранение не требуется/i,
    );
  });

  it("keeps lift instructions for an unchanged same-column background destination", async () => {
    const manager = new DragDropManager({
      plugins: kanbanAccessibilityPlugins,
    });
    const sameColumnTasks: TaskType[] = [
      {
        ...taskC,
        id: "a",
        title: "Задача A",
        position: 1024,
        version: 1,
      },
      {
        ...taskC,
        id: "b",
        title: "Задача B",
        position: 2048,
        version: 1,
      },
      taskC,
    ];

    render(
      <DragDropProvider
        manager={manager}
        plugins={kanbanAccessibilityPlugins}
      >
        <KanbanDndColumn
          id="todo"
          title="К выполнению"
          color="#3b82f6"
          tasks={sameColumnTasks}
          reorderEnabled
          pendingTaskIds={new Set()}
          onCreateTask={vi.fn()}
          onOpenTask={vi.fn()}
        />
      </DragDropProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
      expect(document.body).toHaveTextContent("Чтобы взять задачу, нажмите пробел или Enter");
      expect([...manager.registry.draggables]).toHaveLength(3);
      expect([...manager.registry.droppables]).toHaveLength(4);
    });
    const source = [...manager.registry.draggables].find(
      (draggable) => draggable.id === "c",
    );
    const target = [...manager.registry.droppables].find(
      (droppable) =>
        droppable.type === "column" && droppable.id === "todo",
    );
    expect(source).toBeDefined();
    expect(target).toBeDefined();

    act(() => {
      manager.monitor.dispatch("dragstart", {
        operation: { source, target: null },
      } as DragStartEvent);
      manager.monitor.dispatch("dragover", {
        operation: { source, target },
      } as DragOverEvent);
    });
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Поднята задача «Задача C» из колонки «К выполнению», позиция 3.",
      );
      expect(screen.getByRole("status")).not.toHaveTextContent("позиция 4");
    });

    act(() => {
      manager.monitor.dispatch("dragend", {
        canceled: false,
        operation: { source, target },
      } as DragEndEvent);
    });
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Перемещение задачи «Задача C» обрабатывается.",
      );
    });
    expect(screen.getByRole("status")).not.toHaveTextContent(
      /осталась на прежнем месте|сохранение не требуется/i,
    );
  });

  describe("task drag activation policy", () => {
  it("uses distance for a mouse and delay with tolerance for touch", () => {
    const mouse = getKanbanPointerActivationConstraints({
      pointerType: "mouse",
    } as PointerEvent);
    const touch = getKanbanPointerActivationConstraints({
      pointerType: "touch",
    } as PointerEvent);

    expect(mouse).toHaveLength(1);
    expect(mouse[0]).toBeInstanceOf(PointerActivationConstraints.Distance);
    expect(touch).toHaveLength(1);
    expect(touch[0]).toBeInstanceOf(PointerActivationConstraints.Delay);
  });

  it("does not activate from interactive children outside the drag handle", () => {
    const card = document.createElement("div");
    const link = document.createElement("a");
    const handle = document.createElement("button");
    handle.dataset.kanbanDragHandle = "";
    card.append(link, handle);

    expect(
      preventKanbanPointerActivation(
        { target: link } as unknown as PointerEvent,
      ),
    ).toBe(true);
    expect(
      preventKanbanPointerActivation(
        { target: handle } as unknown as PointerEvent,
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "position sort with no filters",
      input: {
        sortBy: "position",
        statusFilter: null,
        priorityFilter: null,
        assigneeFilter: null,
        tagsFilter: null,
      },
      expected: true,
    },
    {
      name: "non-position sort",
      input: {
        sortBy: "priority-desc",
        statusFilter: null,
        priorityFilter: null,
        assigneeFilter: null,
        tagsFilter: null,
      },
      expected: false,
    },
    {
      name: "status filter",
      input: {
        sortBy: "position",
        statusFilter: "TODO",
        priorityFilter: null,
        assigneeFilter: null,
        tagsFilter: null,
      },
      expected: false,
    },
    {
      name: "priority filter",
      input: {
        sortBy: "position",
        statusFilter: null,
        priorityFilter: "HIGH",
        assigneeFilter: null,
        tagsFilter: null,
      },
      expected: false,
    },
    {
      name: "assignee filter",
      input: {
        sortBy: "position",
        statusFilter: null,
        priorityFilter: null,
        assigneeFilter: "user-1",
        tagsFilter: null,
      },
      expected: false,
    },
    {
      name: "tag filter",
      input: {
        sortBy: "position",
        statusFilter: null,
        priorityFilter: null,
        assigneeFilter: null,
        tagsFilter: ["tag-1"],
      },
      expected: false,
    },
  ])("$name enables drag: $expected", ({ input, expected }) => {
    expect(isTaskReorderEnabled(input)).toBe(expected);
  });
});

describe("KanbanDndBoard", () => {
  it.each([
    { reorderEnabled: false, filtered: false },
    { reorderEnabled: true, filtered: false },
    { reorderEnabled: false, filtered: true },
    { reorderEnabled: true, filtered: true },
  ])("keeps opening and canonical placement without manual controls (reorder=$reorderEnabled, filtered=$filtered)", async ({ reorderEnabled, filtered }) => {
    const moveClient = new RecordingMoveClient();
    const onOpenTask = vi.fn();
    const snapshot = structuredClone(initialState);
    const before = structuredClone(snapshot);
    render(<KanbanDndBoard
      columns={[
        { id: "todo", name: "К выполнению", color: "#3b82f6" },
        { id: "doing", name: "В работе", color: "#f59e0b" },
        { id: "done", name: "Готово", color: "#22c55e" },
      ]}
      snapshot={snapshot} snapshotRevision={1} reorderEnabled={reorderEnabled}
      visibleTaskIds={filtered ? new Set(["c"]) : undefined}
      moveClient={moveClient} onCreateTask={vi.fn()} onOpenTask={onOpenTask}
    />);
    expect(screen.queryByRole("button", { name: /Переместить задачу|Действия задачи/ })).not.toBeInTheDocument();
    const open = screen.getByRole("button", { name: "Открыть задачу «Задача C»" });
    await userEvent.pointer([{ keys: "[MouseLeft>]", target: open }, { keys: "[/MouseLeft]", target: open }]);
    open.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowDown}{Escape}{Enter}");
    expect(onOpenTask).toHaveBeenCalledTimes(2);
    expect(onOpenTask).toHaveBeenLastCalledWith(expect.objectContaining({ id: "c", columnId: "todo", version: 2 }));
    expect(moveClient.requests).toEqual([]);
    expect(snapshot).toEqual(before);
    expect(screen.queryByLabelText("Место вставки задачи")).not.toBeInTheDocument();
  });

  it("renders normalized columns through the modern provider and disables every handle when reordering is unavailable", () => {
    const moveClient = new RecordingMoveClient();

    render(
      <KanbanDndBoard
        columns={[
          { id: "todo", name: "К выполнению", color: "#3b82f6" },
          { id: "doing", name: "В работе", color: "#f59e0b" },
          { id: "done", name: "Готово", color: "#22c55e" },
        ]}
        snapshot={structuredClone(initialState)}
        snapshotRevision={1}
        reorderEnabled={false}
        moveClient={moveClient}
        onCreateTask={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );

    expect(screen.getByText("К выполнению")).toBeInTheDocument();
    expect(screen.getByText("В работе")).toBeInTheDocument();
    expect(screen.getByText("Готово")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Переместить задачу/ })).not.toBeInTheDocument();
    expect(moveClient.requests).toEqual([]);
  });

  it("keeps the normalized board intact while rendering only visible filtered tasks", () => {
    render(
      <KanbanDndBoard
        columns={[
          { id: "todo", name: "К выполнению", color: "#3b82f6" },
          { id: "doing", name: "В работе", color: "#f59e0b" },
          { id: "done", name: "Готово", color: "#22c55e" },
        ]}
        snapshot={structuredClone(initialState)}
        snapshotRevision={1}
        reorderEnabled={false}
        visibleTaskIds={new Set(["a"])}
        moveClient={new RecordingMoveClient()}
        onCreateTask={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /Переместить задачу/ })).not.toBeInTheDocument();
    expect(screen.getByText("Задача A")).toBeInTheDocument();
    expect(screen.queryByText("Задача B")).not.toBeInTheDocument();
  });
});

describe("socket task movement snapshots", () => {
  it("rejects a lower-version generic task update", () => {
    expect(
      shouldApplyTaskVersionSnapshot({
        currentTaskVersion: 4,
        incomingTaskVersion: 3,
      }),
    ).toBe(false);
    expect(
      shouldApplyTaskVersionSnapshot({
        currentTaskVersion: 4,
        incomingTaskVersion: 4,
      }),
    ).toBe(true);
    expect(
      shouldApplyTaskVersionSnapshot({
        currentTaskVersion: 4,
        incomingTaskVersion: undefined,
      }),
    ).toBe(false);
  });

  it("rejects lower task versions and lower board revisions", () => {
    expect(
      shouldApplyTaskMovedSnapshot({
        currentTaskVersion: 3,
        currentBoardRevision: 8,
        incomingTaskVersion: 2,
        incomingBoardRevision: 9,
      }),
    ).toBe(false);
    expect(
      shouldApplyTaskMovedSnapshot({
        currentTaskVersion: 3,
        currentBoardRevision: 8,
        incomingTaskVersion: 4,
        incomingBoardRevision: 7,
      }),
    ).toBe(false);
  });

  it("accepts an equal-or-newer socket snapshot", () => {
    expect(
      shouldApplyTaskMovedSnapshot({
        currentTaskVersion: 3,
        currentBoardRevision: 8,
        incomingTaskVersion: 4,
        incomingBoardRevision: 9,
      }),
    ).toBe(true);
  });
});

describe("useKanbanDnd", () => {
  it("projects and persists a pointer move from drag-start geometry after the active preview reflows the column", async () => {
    const rect = (
      left: number,
      top: number,
      width: number,
      height: number,
    ): DOMRect =>
      ({
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        toJSON: () => ({}),
      }) as DOMRect;
    const addColumn = (
      columnId: string,
      left: number,
      cards: Array<{ id: string; centerY: number }>,
    ) => {
      const column = document.createElement("section");
      column.dataset.columnId = columnId;
      column.getBoundingClientRect = () => rect(left, 200, 300, 600);
      const scroll = document.createElement("div");
      scroll.dataset.kanbanColumnScroll = "";
      scroll.getBoundingClientRect = () => rect(left, 250, 300, 500);
      for (const card of cards) {
        const element = document.createElement("div");
        element.dataset.taskId = card.id;
        element.getBoundingClientRect = () =>
          rect(left + 12, card.centerY - 50, 276, 100);
        scroll.append(element);
      }
      column.append(scroll);
      document.body.append(column);
      return column;
    };
    const todoColumn = addColumn("todo", 0, [
      { id: "a", centerY: 300 },
      { id: "b", centerY: 500 },
      { id: "c", centerY: 700 },
    ]);
    const doingColumn = addColumn("doing", 320, [
      { id: "d", centerY: 500 },
    ]);
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(moveClient, structuredClone(initialState));
    const pointerCenter = { x: 470, y: 400 };
    const manager = {
      dragOperation: {
        position: {
          current: {
            x: 470,
            y: 400,
          },
        },
        shape: {
          current: {
            center: pointerCenter,
          },
        },
      },
    } as unknown as DragDropManager;

    try {
      act(() => {
        harness.controller().handlers.onDragStart(
          {
            ...dragStartEvent({
              taskId: "c",
              initialIndex: 2,
              initialGroup: "todo",
            }),
            nativeEvent: new Event("pointerdown"),
          },
          manager,
        );
        harness.controller().handlers.onDragOver(
          dragEndEvent({
            taskId: "c",
            initialIndex: 2,
            index: 0,
            initialGroup: "todo",
            group: "doing",
            target: {
              id: "d",
              type: "task",
            },
          }) as unknown as DragOverEvent,
          manager,
        );
      });
      expect(readState().taskIdsByColumn.doing).toEqual(["c", "d"]);

      const onDragMove = (
        harness.controller().handlers as unknown as {
          onDragMove?: (
            event: DragMoveEvent,
            manager: DragDropManager,
          ) => void;
        }
      ).onDragMove;
      expect(onDragMove).toBeTypeOf("function");
      act(() => {
        onDragMove?.(
          {
            ...dragEndEvent({
              taskId: "c",
              initialIndex: 2,
              index: 0,
              initialGroup: "todo",
              group: "doing",
              target: {
                id: "c",
              type: "task",
            },
          }),
            by: { x: 0, y: 102 },
          } as unknown as DragMoveEvent,
          manager,
        );
      });
      expect(readState().taskIdsByColumn.doing).toEqual(["c", "d"]);

      act(() => {
        onDragMove?.(
          {
            ...dragEndEvent({
              taskId: "c",
              initialIndex: 2,
              index: 0,
              initialGroup: "todo",
              group: "doing",
              target: {
                id: "c",
                type: "task",
              },
            }),
            by: { x: 0, y: 108 },
          } as unknown as DragMoveEvent,
          manager,
        );
      });

      expect(readState().taskIdsByColumn.doing).toEqual(["d", "c"]);
      expect(moveClient.requests).toEqual([]);

      pointerCenter.y = 600;
      (
        manager as unknown as {
          dragOperation: {
            position: {
              current: { x: number; y: number };
            };
          };
        }
      ).dragOperation.position.current.y = 600;
      act(() => {
        harness.controller().handlers.onDragEnd(
          dragEndEvent({
            taskId: "c",
            initialIndex: 2,
            index: 0,
            initialGroup: "todo",
            group: "doing",
            outside: true,
          }),
          manager,
        );
      });

      await waitFor(() => expect(moveClient.requests).toHaveLength(1));
      expect(moveClient.requests[0]).toMatchObject({
        taskId: "c",
        request: {
          toColumnId: "doing",
          beforeTaskId: "d",
          afterTaskId: null,
        },
      });
    } finally {
      todoColumn.remove();
      doingColumn.remove();
    }
  });

  it("reconciles cross-column optimistic sorting during dragover before persistence", () => {
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(
      moveClient,
      structuredClone(initialState),
    );
    const manager = new DragDropManager();

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        manager,
      );
      harness.controller().handlers.onDragOver(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 1,
          initialGroup: "todo",
          group: "doing",
        }) as unknown as DragOverEvent,
        manager,
      );
    });

    expect(readState().taskIdsByColumn).toEqual({
      todo: ["a", "b"],
      doing: ["d", "c"],
      done: [],
    });
    expect(screen.getByTestId("dragging")).toHaveTextContent("true");
    expect(screen.getByTestId("pending")).toHaveTextContent("false");
    expect(moveClient.requests).toEqual([]);
  });

  it("uses the last dragover destination when dragend sortable metadata is stale", async () => {
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(
      moveClient,
      structuredClone(initialState),
    );
    const manager = new DragDropManager();

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        manager,
      );
      harness.controller().handlers.onDragOver(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 2,
          initialGroup: "todo",
          group: "todo",
          target: {
            id: "doing",
            type: "column",
            data: {
              columnId: "doing",
            },
          },
        }) as unknown as DragOverEvent,
        manager,
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 2,
          initialGroup: "todo",
          group: "todo",
        }),
        manager,
      );
    });

    await waitFor(() => expect(moveClient.requests).toHaveLength(1));
    expect(moveClient.requests[0]).toMatchObject({
      taskId: "c",
      request: {
        toColumnId: "doing",
        beforeTaskId: "d",
        afterTaskId: null,
      },
    });
  });

  it("keeps the last meaningful keyboard destination when dnd-kit recenters on the source", async () => {
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(
      moveClient,
      structuredClone(initialState),
    );
    const manager = new DragDropManager();

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        manager,
      );
      harness.controller().handlers.onDragOver(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 2,
          initialGroup: "todo",
          group: "todo",
          target: {
            id: "doing",
            type: "column",
            data: {
              columnId: "doing",
            },
          },
        }) as unknown as DragOverEvent,
        manager,
      );
      harness.controller().handlers.onDragOver(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 2,
          initialGroup: "todo",
          group: "todo",
          target: {
            id: "c",
            type: "task",
          },
        }) as unknown as DragOverEvent,
        manager,
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 2,
          initialGroup: "todo",
          group: "todo",
        }),
        manager,
      );
    });

    await waitFor(() => expect(moveClient.requests).toHaveLength(1));
    expect(moveClient.requests[0]).toMatchObject({
      taskId: "c",
      request: {
        toColumnId: "doing",
        beforeTaskId: "d",
        afterTaskId: null,
      },
    });
  });

  it("uses the drag snapshot when dnd-kit mutates the source initial group during keyboard sorting", async () => {
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(
      moveClient,
      structuredClone(initialState),
    );
    const manager = new DragDropManager();

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        manager,
      );
      harness.controller().handlers.onDragOver(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 2,
          initialGroup: "todo",
          group: "todo",
          target: {
            id: "doing",
            type: "column",
            data: {
              columnId: "doing",
            },
          },
        }) as unknown as DragOverEvent,
        manager,
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 0,
          index: 0,
          initialGroup: "doing",
          group: "doing",
          target: {
            id: "c",
            type: "task",
          },
        }),
        manager,
      );
    });

    await waitFor(() => expect(moveClient.requests).toHaveLength(1));
    expect(moveClient.requests[0]).toMatchObject({
      taskId: "c",
      request: {
        toColumnId: "doing",
        beforeTaskId: "d",
        afterTaskId: null,
      },
    });
  });

  it("accepts multiple keyboard column steps after dnd-kit mutates the source group", async () => {
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(
      moveClient,
      structuredClone(initialState),
    );
    const manager = new DragDropManager();

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        manager,
      );
      harness.controller().handlers.onDragOver(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 2,
          initialGroup: "todo",
          group: "todo",
          target: {
            id: "doing",
            type: "column",
            data: {
              columnId: "doing",
            },
          },
        }) as unknown as DragOverEvent,
        manager,
      );
      harness.controller().handlers.onDragOver(
        dragEndEvent({
          taskId: "c",
          initialIndex: 0,
          index: 0,
          initialGroup: "doing",
          group: "doing",
          target: {
            id: "done",
            type: "column",
            data: {
              columnId: "done",
            },
          },
        }) as unknown as DragOverEvent,
        manager,
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 0,
          index: 0,
          initialGroup: "done",
          group: "done",
          target: {
            id: "c",
            type: "task",
          },
        }),
        manager,
      );
    });

    await waitFor(() => expect(moveClient.requests).toHaveLength(1));
    expect(moveClient.requests[0]).toMatchObject({
      taskId: "c",
      request: {
        toColumnId: "done",
        beforeTaskId: null,
        afterTaskId: null,
      },
    });
  });

  it("settles a same-column background no-op before pending and publishes an accurate announcement", () => {
    const moveClient = new RecordingMoveClient();
    const snapshot = structuredClone(initialState);
    const settlements: KanbanPointerMoveSettlement[] = [];
    const announcements: string[] = [];
    const harness = renderHarness(moveClient, snapshot, {
      onPointerMoveSettled: (settlement) => {
        settlements.push(settlement);
        const status: string = settlement.status;
        if (status === "unchanged") {
          announcements.push(announceMoveUnchanged(settlement.taskTitle));
        }
      },
    });

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 2,
          initialGroup: "todo",
          group: "todo",
          target: {
            id: "todo",
            type: "column",
            data: {
              columnId: "todo",
            },
          },
        }),
        new DragDropManager(),
      );
    });

    expect(readState()).toEqual(snapshot);
    expect(screen.getByTestId("pending")).toHaveTextContent("false");
    expect(moveClient.requests).toEqual([]);
    expect(settlements).toEqual([
      {
        status: "unchanged",
        taskId: "c",
        taskTitle: "Задача C",
        fromColumnId: "todo",
        toColumnId: "todo",
        targetIndex: 3,
      },
    ]);
    expect(announcements).toEqual([
      "Задача «Задача C» осталась на прежнем месте. Сохранение не требуется.",
    ]);
  });

  it("reports pointer success only after the async move is confirmed", async () => {
    let resolveMove!: (response: MoveTaskResponse) => void;
    const moveClient = new RecordingMoveClient(
      () =>
        new Promise<MoveTaskResponse>((resolve) => {
          resolveMove = resolve;
        }),
    );
    const settlements: KanbanPointerMoveSettlement[] = [];
    const harness = renderHarness(moveClient, structuredClone(initialState), {
      onPointerMoveSettled: (settlement) => settlements.push(settlement),
    });

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 1,
          initialGroup: "todo",
          group: "doing",
        }),
        new DragDropManager(),
      );
    });

    await waitFor(() => expect(moveClient.requests).toHaveLength(1));
    expect(settlements).toEqual([]);

    const response: MoveTaskResponse = {
      operationId: moveClient.requests[0].request.operationId,
      boardRevision: 2,
      task: {
        id: "c",
        columnId: "doing",
        version: 3,
        status: "IN_PROGRESS",
      },
    };
    await act(async () => {
      resolveMove(response);
      await Promise.resolve();
    });

    expect(settlements).toEqual([
      {
        status: "confirmed",
        taskId: "c",
        taskTitle: "Задача C",
        fromColumnId: "todo",
        toColumnId: "doing",
        targetIndex: 1,
        position: 2,
        total: 2,
        response,
      },
    ]);
  });

  it("reports the original conflict after restoring the exact pointer snapshot", async () => {
    let rejectMove!: (error: unknown) => void;
    const conflict = Object.assign(new Error("stale version"), {
      status: 409,
      payload: {
        error: {
          code: "STALE_TASK_VERSION",
        },
      },
    });
    const moveClient = new RecordingMoveClient(
      () =>
        new Promise<MoveTaskResponse>((_resolve, reject) => {
          rejectMove = reject;
        }),
    );
    const settlements: KanbanPointerMoveSettlement[] = [];
    const snapshot = structuredClone(initialState);
    const harness = renderHarness(moveClient, snapshot, {
      onPointerMoveSettled: (settlement) => settlements.push(settlement),
    });

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 1,
          initialGroup: "todo",
          group: "doing",
        }),
        new DragDropManager(),
      );
    });
    await waitFor(() => expect(moveClient.requests).toHaveLength(1));

    await act(async () => {
      rejectMove(conflict);
      await Promise.resolve();
    });

    expect(readState()).toEqual(snapshot);
    expect(settlements).toEqual([
      {
        status: "failed",
        taskId: "c",
        taskTitle: "Задача C",
        fromColumnId: "todo",
        toColumnId: "doing",
        targetIndex: 1,
        error: conflict,
      },
    ]);
  });

  it.each([
    { preview: false, background: false, index: 0, before: null, after: "a", ids: ["c", "a", "b"] },
    { preview: false, background: false, index: 99, before: "b", after: null, ids: ["a", "b", "c"] },
    { preview: true, background: false, index: 0, before: null, after: "a", ids: ["c", "a", "b"] },
    { preview: true, background: false, index: 99, before: "b", after: null, ids: ["a", "b", "c"] },
    { preview: false, background: true, index: 99, before: "b", after: null, ids: ["a", "b", "c"] },
    { preview: true, background: true, index: 99, before: "b", after: null, ids: ["a", "b", "c"] },
  ])("#94 accepts a drag forward and back into a populated column (preview=$preview, background=$background, index=$index)", async ({ preview, background, index, before, after, ids }) => {
    const canonical = structuredClone(initialState);
    const onMoveError = vi.fn();
    const onMoveConfirmed = vi.fn();
    const settlements: KanbanPointerMoveSettlement[] = [];
    const moveClient = new RecordingMoveClient(async ({ taskId, request }) => {
      const destination = canonical.taskIdsByColumn[request.toColumnId].filter(id => id !== taskId);
      const insertionIndex = request.beforeTaskId === null
        ? 0
        : destination.indexOf(request.beforeTaskId) + 1;
      // Reject invalid anchors instead of accepting every request in the transport stub.
      if (
        request.beforeTaskId !== (destination[insertionIndex - 1] ?? null) ||
        request.afterTaskId !== (destination[insertionIndex] ?? null) ||
        (destination.length > 0 && request.beforeTaskId === null && request.afterTaskId === null)
      ) {
        throw Object.assign(new Error("INVALID_MOVE_NEIGHBORS"), { status: 422 });
      }
      const task = canonical.tasksById[taskId];
      expect(request.expectedVersion).toBe(task.version);
      canonical.taskIdsByColumn[task.columnId] = canonical.taskIdsByColumn[task.columnId].filter(id => id !== taskId);
      destination.splice(insertionIndex, 0, taskId);
      canonical.taskIdsByColumn[request.toColumnId] = destination;
      task.columnId = request.toColumnId;
      task.version += 1;
      return {
        operationId: request.operationId, boardRevision: task.version,
        task: { id: taskId, columnId: task.columnId, version: task.version, status: task.columnId === "todo" ? "TODO" : "IN_PROGRESS" },
      };
    });
    const harness = renderHarness(moveClient, structuredClone(initialState), {
      onMoveError, onMoveConfirmed,
      onPointerMoveSettled: settlement => settlements.push(settlement),
    });
    const manager = new DragDropManager();
    for (const [step, from, to, initialIndex, targetIndex] of [
      [1, "todo", "doing", 2, 1],
      [2, "doing", "todo", 1, index],
    ] as const) {
      act(() => {
        harness.controller().handlers.onDragStart(dragStartEvent({ taskId: "c", initialGroup: from, initialIndex }), manager);
        const event = dragEndEvent({
          taskId: "c", initialGroup: from, group: to, initialIndex, index: targetIndex,
          target: background ? { id: to, type: "column", data: { columnId: to } } : undefined,
        });
        if (preview) harness.controller().handlers.onDragOver(event as unknown as DragOverEvent, manager);
        harness.controller().handlers.onDragEnd(event, manager);
      });
      expect(readState().taskIdsByColumn[to]).toEqual(step === 1 ? ["d", "c"] : ids);
      expect(readState().tasksById.c.version).toBe(step + 1);
      expect(harness.controller().hasPendingMoves).toBe(true);
      await waitFor(() => expect(onMoveConfirmed).toHaveBeenCalledTimes(step));
      await waitFor(() => expect(harness.controller().hasPendingMoves).toBe(false));
    }
    expect(moveClient.requests.map(({ request }) => request)).toEqual([
      { toColumnId: "doing", beforeTaskId: "d", afterTaskId: null, expectedVersion: 2, operationId: expect.any(String) },
      { toColumnId: "todo", beforeTaskId: before, afterTaskId: after, expectedVersion: 3, operationId: expect.any(String) },
    ]);
    expect(onMoveError).not.toHaveBeenCalled();
    expect(settlements.map(settlement => settlement.status)).toEqual(["confirmed", "confirmed"]);
    expect(readState().taskIdsByColumn).toEqual({ todo: ids, doing: ["d"], done: [] });
    expect(readState().tasksById.c.version).toBe(4);
  });

  it("uses the committed version and canonical anchors for a forward then backward semantic move", async () => {
    const moveClient = new RecordingMoveClient(async ({ taskId, request }) => ({
      operationId: request.operationId, boardRevision: request.expectedVersion + 1,
      task: { id: taskId, columnId: request.toColumnId, version: request.expectedVersion + 1,
        status: request.toColumnId === "todo" ? "TODO" : "IN_PROGRESS" },
    }));
    let sequence = 0;
    const harness = renderHarness(moveClient, structuredClone(initialState), { createOperationId: () => `roundtrip-${++sequence}` });
    await act(async () => { await harness.controller().moveTask({ taskId: "c", toColumnId: "doing", targetIndex: 1 }); });
    await act(async () => { await harness.controller().moveTask({ taskId: "c", toColumnId: "todo", targetIndex: 0 }); });
    expect(moveClient.requests.map(input => input.request)).toEqual([
      { toColumnId: "doing", beforeTaskId: "d", afterTaskId: null, expectedVersion: 2, operationId: "roundtrip-1" },
      { toColumnId: "todo", beforeTaskId: null, afterTaskId: "a", expectedVersion: 3, operationId: "roundtrip-2" },
    ]);
    expect(harness.controller().state.taskIdsByColumn.todo).toEqual(["c", "a", "b"]);
    expect(harness.controller().state.tasksById.c.version).toBe(4);
  });
  it("restores a subset-visible snapshot after invalid-neighbor rejection without inventing a second placement", async () => {
    const visible = structuredClone(initialState);
    visible.taskIdsByColumn.todo = [];
    visible.taskIdsByColumn.done = ["c"];
    visible.tasksById.c = { ...visible.tasksById.c, columnId: "done", version: 3 };
    delete visible.tasksById.a;delete visible.tasksById.b;
    const error = Object.assign(new Error("private hidden anchor"), { status: 422, payload: { error: { code: "INVALID_MOVE_NEIGHBORS" } } });
    const onMoveError = vi.fn();
    const moveClient = new RecordingMoveClient(async () => { throw error; });
    const harness = renderHarness(moveClient, visible, { onMoveError });
    await act(async () => {
      await expect(harness.controller().moveTask({ taskId: "c", toColumnId: "todo", targetIndex: 0 })).rejects.toBe(error);
    });
    expect(harness.controller().state).toEqual(visible);
    expect(moveClient.requests).toHaveLength(1);
    expect(moveClient.requests[0].request).toMatchObject({ toColumnId: "todo", beforeTaskId: null, afterTaskId: null, expectedVersion: 3 });
    expect(harness.controller().hasPendingMoves).toBe(false);
    expect(onMoveError).toHaveBeenCalledExactlyOnceWith(error);
  });
  it("routes a semantic menu move through the same optimistic coordinator", async () => {
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(moveClient, structuredClone(initialState), {
      createOperationId: () => "menu-operation",
    });

    await act(async () => {
      await harness.controller().moveTask({
        taskId: "c",
        toColumnId: "doing",
        targetIndex: 1,
      });
    });

    expect(readState().taskIdsByColumn).toEqual({
      todo: ["a", "b"],
      doing: ["d", "c"],
      done: [],
    });
    expect(moveClient.requests).toEqual([
      {
        taskId: "c",
        request: {
          toColumnId: "doing",
          beforeTaskId: "d",
          afterTaskId: null,
          operationId: "menu-operation",
          expectedVersion: 2,
        },
      },
    ]);
  });

  it("restores the exact pre-drag snapshot when Escape cancels a drag", () => {
    const snapshot = structuredClone(initialState);
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(moveClient, snapshot);

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 1,
          initialGroup: "todo",
          group: "doing",
          canceled: true,
          nativeEvent: new KeyboardEvent("keydown", { key: "Escape" }),
        }),
        new DragDropManager(),
      );
    });

    expect(readState()).toEqual(snapshot);
    expect(moveClient.requests).toEqual([]);
    expect(screen.getByTestId("dragging")).toHaveTextContent("false");
  });

  it("restores the snapshot and sends no command for an outside drop", () => {
    const snapshot = structuredClone(initialState);
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(moveClient, snapshot);

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 1,
          initialGroup: "todo",
          group: "doing",
          outside: true,
        }),
        new DragDropManager(),
      );
    });

    expect(readState()).toEqual(snapshot);
    expect(moveClient.requests).toEqual([]);
  });

  it("sends one semantic neighbor command from sortable group and index state", async () => {
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(moveClient);

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 1,
          initialGroup: "todo",
          group: "doing",
        }),
        new DragDropManager(),
      );
    });

    expect(readState().taskIdsByColumn).toEqual({
      todo: ["a", "b"],
      doing: ["d", "c"],
      done: [],
    });

    await waitFor(() => expect(moveClient.requests).toHaveLength(1));
    expect(moveClient.requests).toEqual([
      {
        taskId: "c",
        request: {
          toColumnId: "doing",
          beforeTaskId: "d",
          afterTaskId: null,
          operationId: expect.any(String),
          expectedVersion: 2,
        },
      },
    ]);
    await waitFor(() => {
      expect(screen.getByTestId("pending")).toHaveTextContent("false");
    });
  });

  it.each([
    {
      destination: "done",
      expectedIds: ["c"],
      beforeTaskId: null,
      label: "empty column",
    },
    {
      destination: "doing",
      expectedIds: ["d", "c"],
      beforeTaskId: "d",
      label: "column background",
    },
  ])(
    "derives an append destination from a plain $label target when sortable location stays unchanged",
    async ({ destination, expectedIds, beforeTaskId }) => {
      const moveClient = new RecordingMoveClient();
      const harness = renderHarness(moveClient);

      act(() => {
        harness.controller().handlers.onDragStart(
          dragStartEvent({
            taskId: "c",
            initialIndex: 2,
            initialGroup: "todo",
          }),
          new DragDropManager(),
        );
        harness.controller().handlers.onDragEnd(
          dragEndEvent({
            taskId: "c",
            initialIndex: 2,
            index: 2,
            initialGroup: "todo",
            group: "todo",
            target: {
              id: destination,
              type: "column",
              data: { columnId: destination },
            },
          }),
          new DragDropManager(),
        );
      });

      expect(readState().taskIdsByColumn[destination]).toEqual(expectedIds);
      await waitFor(() => expect(moveClient.requests).toHaveLength(1));
      expect(moveClient.requests[0]).toEqual({
        taskId: "c",
        request: {
          toColumnId: destination,
          beforeTaskId,
          afterTaskId: null,
          operationId: expect.any(String),
          expectedVersion: 2,
        },
      });
    },
  );

  it("sends no command when sortable initial and final locations are unchanged", () => {
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(moveClient);

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 2,
          initialGroup: "todo",
          group: "todo",
        }),
        new DragDropManager(),
      );
    });

    expect(readState()).toEqual(initialState);
    expect(moveClient.requests).toEqual([]);
  });

  it("rolls back and reports a synchronous operation ID failure", () => {
    const snapshot = structuredClone(initialState);
    const moveClient = new RecordingMoveClient();
    const operationIdError = new Error("random UUID unavailable");
    const onMoveError = vi.fn();
    const harness = renderHarness(moveClient, snapshot, {
      createOperationId() {
        throw operationIdError;
      },
      onMoveError,
    });

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 1,
          initialGroup: "todo",
          group: "doing",
        }),
        new DragDropManager(),
      );
    });

    expect(readState()).toEqual(snapshot);
    expect(moveClient.requests).toEqual([]);
    expect(onMoveError).toHaveBeenCalledWith(operationIdError);
    expect(screen.getByTestId("pending")).toHaveTextContent("false");
  });

  it("restores the exact snapshot when the move request is rejected", async () => {
    const snapshot = structuredClone(initialState);
    const moveClient = new RecordingMoveClient(async () => {
      throw new Error("conflict");
    });
    const harness = renderHarness(moveClient, snapshot);

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 1,
          initialGroup: "todo",
          group: "doing",
        }),
        new DragDropManager(),
      );
    });

    expect(readState().taskIdsByColumn.doing).toEqual(["d", "c"]);
    await waitFor(() => expect(readState()).toEqual(snapshot));
    expect(moveClient.requests).toHaveLength(1);
  });

  it("restores the drag snapshot before applying a newer deferred snapshot after rejection", async () => {
    let rejectMove!: (error: Error) => void;
    const moveClient = new RecordingMoveClient(
      () =>
        new Promise<MoveTaskResponse>((_resolve, reject) => {
          rejectMove = reject;
        }),
    );
    const renderedStates: KanbanBoardState[] = [];
    const snapshot = structuredClone(initialState);
    const harness = renderHarness(moveClient, snapshot, {
      onExpose(controller) {
        renderedStates.push(structuredClone(controller.state));
      },
    });
    const incoming = structuredClone(initialState);
    incoming.tasksById.a = {
      ...incoming.tasksById.a,
      title: "Удаленное обновление",
      version: 2,
    };

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 1,
          initialGroup: "todo",
          group: "doing",
        }),
        new DragDropManager(),
      );
    });
    harness.rerenderSnapshot(incoming, 3);

    expect(readState().tasksById.a.title).toBe("Задача A");
    await waitFor(() => expect(rejectMove).toBeTypeOf("function"));

    await act(async () => {
      rejectMove(new Error("conflict"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(readState()).toEqual(incoming);
    });
    expect(renderedStates).toContainEqual(snapshot);
    expect(moveClient.requests).toHaveLength(1);
  });

  it("preserves a confirmed move while applying deferred unrelated updates, creates, and deletes", async () => {
    let resolveMove!: (response: MoveTaskResponse) => void;
    const moveClient = new RecordingMoveClient(
      () =>
        new Promise<MoveTaskResponse>((resolve) => {
          resolveMove = resolve;
        }),
    );
    const harness = renderHarness(moveClient);
    const incoming = structuredClone(initialState);
    incoming.taskIdsByColumn.todo = ["a", "c", "e"];
    delete incoming.tasksById.b;
    incoming.tasksById.a = {
      ...incoming.tasksById.a,
      title: "Удаленное обновление",
      version: 2,
    };
    incoming.tasksById.e = {
      id: "e",
      columnId: "todo",
      position: 4096,
      version: 1,
      title: "Новая задача",
    };

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 1,
          initialGroup: "todo",
          group: "doing",
        }),
        new DragDropManager(),
      );
    });
    harness.rerenderSnapshot(incoming, 1);
    await waitFor(() => expect(resolveMove).toBeTypeOf("function"));

    await act(async () => {
      resolveMove({
        operationId: moveClient.requests[0].request.operationId,
        boardRevision: 2,
        task: {
          id: "c",
          columnId: "doing",
          version: 3,
          status: "IN_PROGRESS",
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(readState().taskIdsByColumn).toEqual({
        todo: ["a", "e"],
        doing: ["d", "c"],
        done: [],
      });
    });
    expect(readState().tasksById.a.title).toBe("Удаленное обновление");
    expect(readState().tasksById.e.title).toBe("Новая задача");
    expect(readState().tasksById.b).toBeUndefined();
    expect(readState().tasksById.c).toMatchObject({
      columnId: "doing",
      version: 3,
    });
  });

  it("requests canonical refresh after REST success when no socket event arrives", async () => {
    const onMoveConfirmed = vi.fn();
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(
      moveClient,
      structuredClone(initialState),
      { onMoveConfirmed },
    );

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 0,
          initialGroup: "todo",
          group: "todo",
        }),
        new DragDropManager(),
      );
    });

    await waitFor(() => expect(onMoveConfirmed).toHaveBeenCalledTimes(1));
    expect(onMoveConfirmed.mock.calls[0][0]).toMatchObject({
      boardRevision: 2,
      task: { id: "c", version: 3 },
    });
    expect(readState().taskIdsByColumn.todo).toEqual(["c", "a", "b"]);

    const onCanonicalRefresh = vi.fn();
    requestCanonicalTaskMovedRefresh({
      currentTaskVersion: 3,
      currentBoardRevision: 2,
      move: onMoveConfirmed.mock.calls[0][0],
      onRefresh: onCanonicalRefresh,
    });

    expect(onCanonicalRefresh).toHaveBeenCalledWith(2);
    expect(readState().taskIdsByColumn.todo).toEqual(["c", "a", "b"]);

    const canonical = structuredClone(initialState);
    canonical.taskIdsByColumn.todo = ["c", "a", "b"];
    canonical.tasksById.c = {
      ...canonical.tasksById.c,
      position: 512,
      version: 3,
    };
    harness.rerenderSnapshot(canonical, 2);

    await waitFor(() => {
      expect(readState().taskIdsByColumn.todo).toEqual(["c", "a", "b"]);
    });
  });

  it("accepts an idle higher-version canonical move with a different same-column order", async () => {
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(moveClient);

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 1,
          initialGroup: "todo",
          group: "doing",
        }),
        new DragDropManager(),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("pending")).toHaveTextContent("false");
      expect(readState().taskIdsByColumn.doing).toEqual(["d", "c"]);
      expect(readState().tasksById.c.version).toBe(3);
    });

    const laterCanonicalMove = structuredClone(initialState);
    laterCanonicalMove.taskIdsByColumn.todo = ["a", "b"];
    laterCanonicalMove.taskIdsByColumn.doing = ["c", "d"];
    laterCanonicalMove.tasksById.c = {
      ...laterCanonicalMove.tasksById.c,
      columnId: "doing",
      position: 512,
      version: 4,
    };
    harness.rerenderSnapshot(laterCanonicalMove, 3);

    await waitFor(() => {
      expect(readState().taskIdsByColumn.doing).toEqual(["c", "d"]);
      expect(readState().tasksById.c).toMatchObject({
        columnId: "doing",
        position: 512,
        version: 4,
      });
    });
  });

  it("accepts a deferred higher-version canonical move to a different column", async () => {
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(moveClient);

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 1,
          initialGroup: "todo",
          group: "doing",
        }),
        new DragDropManager(),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("pending")).toHaveTextContent("false");
      expect(readState().taskIdsByColumn.doing).toEqual(["d", "c"]);
      expect(readState().tasksById.c.version).toBe(3);
    });

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "a",
          initialIndex: 0,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
    });

    const laterCanonicalMove = structuredClone(initialState);
    laterCanonicalMove.taskIdsByColumn.todo = ["a", "b"];
    laterCanonicalMove.taskIdsByColumn.doing = ["d"];
    laterCanonicalMove.taskIdsByColumn.done = ["c"];
    laterCanonicalMove.tasksById.c = {
      ...laterCanonicalMove.tasksById.c,
      columnId: "done",
      position: 1024,
      version: 4,
    };
    harness.rerenderSnapshot(laterCanonicalMove, 3);

    act(() => {
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "a",
          initialIndex: 0,
          index: 0,
          initialGroup: "todo",
          group: "todo",
          canceled: true,
        }),
        new DragDropManager(),
      );
    });

    await waitFor(() => {
      expect(readState().taskIdsByColumn.doing).toEqual(["d"]);
      expect(readState().taskIdsByColumn.done).toEqual(["c"]);
      expect(readState().tasksById.c).toMatchObject({
        columnId: "done",
        position: 1024,
        version: 4,
      });
    });
  });

  it("clears a confirmed move after an idle canonical confirmation so a later equal-revision deletion stays deleted", async () => {
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(moveClient);

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 1,
          initialGroup: "todo",
          group: "doing",
        }),
        new DragDropManager(),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("pending")).toHaveTextContent("false");
      expect(readState().tasksById.c).toMatchObject({
        columnId: "doing",
        version: 3,
      });
    });

    const canonicalConfirmation = structuredClone(initialState);
    canonicalConfirmation.taskIdsByColumn.todo = ["a", "b"];
    canonicalConfirmation.taskIdsByColumn.doing = ["d", "c"];
    canonicalConfirmation.tasksById.c = {
      ...canonicalConfirmation.tasksById.c,
      columnId: "doing",
      position: 2048,
      version: 3,
    };
    harness.rerenderSnapshot(canonicalConfirmation, 2);

    await waitFor(() => {
      expect(readState().taskIdsByColumn.doing).toEqual(["d", "c"]);
    });

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "a",
          initialIndex: 0,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
    });

    const equalRevisionDeletion = structuredClone(canonicalConfirmation);
    equalRevisionDeletion.taskIdsByColumn.doing = ["d"];
    delete equalRevisionDeletion.tasksById.c;
    equalRevisionDeletion.tasksById.b = {
      ...equalRevisionDeletion.tasksById.b,
      title: "Обновлено после подтверждения",
      version: 2,
    };
    harness.rerenderSnapshot(equalRevisionDeletion, 2);

    act(() => {
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "a",
          initialIndex: 0,
          index: 0,
          initialGroup: "todo",
          group: "todo",
          canceled: true,
        }),
        new DragDropManager(),
      );
    });

    await waitFor(() => {
      expect(readState().tasksById.c).toBeUndefined();
      expect(readState().taskIdsByColumn.doing).toEqual(["d"]);
      expect(readState().tasksById.b.title).toBe(
        "Обновлено после подтверждения",
      );
    });
  });

  it("clears a confirmed move when an idle equal-revision canonical snapshot deletes the moved task", async () => {
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(moveClient);

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 1,
          initialGroup: "todo",
          group: "doing",
        }),
        new DragDropManager(),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("pending")).toHaveTextContent("false");
      expect(readState().tasksById.c.version).toBe(3);
    });

    const canonicalDeletion = structuredClone(initialState);
    canonicalDeletion.taskIdsByColumn.todo = ["a", "b"];
    delete canonicalDeletion.tasksById.c;
    harness.rerenderSnapshot(canonicalDeletion, 2);

    await waitFor(() => {
      expect(readState().tasksById.c).toBeUndefined();
      expect(readState().taskIdsByColumn.todo).toEqual(["a", "b"]);
    });

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "a",
          initialIndex: 0,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
    });

    const equalRevisionUpdate = structuredClone(canonicalDeletion);
    equalRevisionUpdate.tasksById.b = {
      ...equalRevisionUpdate.tasksById.b,
      title: "Обновлено после удаления",
      version: 2,
    };
    harness.rerenderSnapshot(equalRevisionUpdate, 2);

    act(() => {
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "a",
          initialIndex: 0,
          index: 0,
          initialGroup: "todo",
          group: "todo",
          canceled: true,
        }),
        new DragDropManager(),
      );
    });

    await waitFor(() => {
      expect(readState().tasksById.b.title).toBe("Обновлено после удаления");
      expect(readState().tasksById.c).toBeUndefined();
    });
  });

  it("defers a query snapshot received during a drag until the drag ends", async () => {
    const moveClient = new RecordingMoveClient();
    const harness = renderHarness(moveClient);
    const incoming = structuredClone(initialState);
    incoming.tasksById.a = {
      ...incoming.tasksById.a,
      title: "Обновлено запросом",
      version: 2,
    };

    act(() => {
      harness.controller().handlers.onDragStart(
        dragStartEvent({
          taskId: "c",
          initialIndex: 2,
          initialGroup: "todo",
        }),
        new DragDropManager(),
      );
    });
    harness.rerenderSnapshot(incoming, 2);

    expect(readState().tasksById.a.title).toBe("Задача A");

    act(() => {
      harness.controller().handlers.onDragEnd(
        dragEndEvent({
          taskId: "c",
          initialIndex: 2,
          index: 2,
          initialGroup: "todo",
          group: "todo",
          canceled: true,
        }),
        new DragDropManager(),
      );
    });

    await waitFor(() => {
      expect(readState().tasksById.a.title).toBe("Обновлено запросом");
    });
  });
});
