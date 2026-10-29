"use client";

import {
  useCallback,
  createContext,
  useContext,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MoreHorizontal } from "lucide-react";
import {
  announceMove,
  announceMoveError,
} from "../accessibility/move-announcements";
import type { KanbanBoardState } from "../model/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface TaskMoveMenuColumn {
  id: string;
  name: string;
  taskCount: number;
}

export interface TaskMoveMenuCommand {
  taskId: string;
  toColumnId: string;
  targetIndex: number;
}

export interface TaskMoveMenuProps {
  taskId: string;
  taskTitle: string;
  currentColumn: Pick<TaskMoveMenuColumn, "id" | "name">;
  currentIndex: number;
  currentColumnTaskCount: number;
  destinationColumns: readonly TaskMoveMenuColumn[];
  onMove: (command: TaskMoveMenuCommand) => void | Promise<unknown>;
  isVisibleAfterMove?: (command: TaskMoveMenuCommand) => boolean;
  boardHeadingRef?: React.RefObject<HTMLElement | null>;
  onAnnounce?: (message: string) => void;
  disabled?: boolean;
  positionMovesEnabled?: boolean;
  registerTrigger?: (
    taskId: string,
    trigger: HTMLButtonElement,
  ) => () => void;
  requestFocus?: (request: TaskMoveFocusRequest) => void;
}

export interface TaskMoveFocusRequest {
  taskId: string;
  target: "trigger" | "board-heading";
}

export interface TaskMoveMenuContextValue {
  canMove?: boolean;
  state: KanbanBoardState;
  columns: readonly Omit<TaskMoveMenuColumn, "taskCount">[];
  pendingTaskIds: ReadonlySet<string>;
  positionMovesEnabled?: boolean;
  moveTask: (command: TaskMoveMenuCommand) => void | Promise<unknown>;
  isTaskVisibleAfterMove?: (taskId: string, toColumnId: string) => boolean;
  boardHeadingRef?: React.RefObject<HTMLElement | null>;
  onAnnounce?: (message: string) => void;
}

interface TaskMoveMenuRuntimeContextValue extends TaskMoveMenuContextValue {
  registerTrigger: (
    taskId: string,
    trigger: HTMLButtonElement,
  ) => () => void;
  requestFocus: (request: TaskMoveFocusRequest) => void;
}

const TaskMoveMenuContext =
  createContext<TaskMoveMenuRuntimeContextValue | null>(null);

export function TaskMoveMenuProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: TaskMoveMenuContextValue;
}): React.ReactElement {
  const triggersRef = useRef(new Map<string, HTMLButtonElement>());
  const focusRequestRef = useRef<TaskMoveFocusRequest | null>(null);
  const [focusRequestVersion, scheduleFocus] = useReducer(
    (version: number) => version + 1,
    0,
  );
  const registerTrigger = useCallback(
    (taskId: string, trigger: HTMLButtonElement) => {
      triggersRef.current.set(taskId, trigger);
      return () => {
        if (triggersRef.current.get(taskId) === trigger) {
          triggersRef.current.delete(taskId);
        }
      };
    },
    [],
  );
  const requestFocus = useCallback((request: TaskMoveFocusRequest) => {
    focusRequestRef.current = request;
    scheduleFocus();
  }, []);

  useLayoutEffect(() => {
    const request = focusRequestRef.current;
    if (!request) {
      return;
    }

    queueMicrotask(() => {
      if (focusRequestRef.current !== request) {
        return;
      }
      const target =
        request.target === "board-heading"
          ? value.boardHeadingRef?.current
          : triggersRef.current.get(request.taskId);
      if (target?.isConnected) {
        target.focus();
        focusRequestRef.current = null;
      }
    });
  }, [focusRequestVersion, value.boardHeadingRef, value.state]);

  return (
    <TaskMoveMenuContext.Provider
      value={{ ...value, registerTrigger, requestFocus }}
    >
      {children}
    </TaskMoveMenuContext.Provider>
  );
}

export function ContextualTaskMoveMenu({
  taskId,
  taskTitle,
}: {
  taskId: string;
  taskTitle: string;
}): React.ReactElement | null {
  const context = useContext(TaskMoveMenuContext);
  if (!context || context.canMove === false) {
    return null;
  }

  const task = context.state.tasksById[taskId];
  const currentTaskIds = task
    ? context.state.taskIdsByColumn[task.columnId]
    : undefined;
  const currentIndex = currentTaskIds?.indexOf(taskId) ?? -1;
  const currentColumn = task
    ? context.columns.find((column) => column.id === task.columnId)
    : undefined;
  if (!task || !currentTaskIds || currentIndex < 0 || !currentColumn) {
    return null;
  }

  const destinationColumns = context.columns
    .filter((column) => column.id !== currentColumn.id)
    .map((column) => ({
      ...column,
      taskCount: context.state.taskIdsByColumn[column.id]?.length ?? 0,
    }));

  return (
    <TaskMoveMenu
      taskId={taskId}
      taskTitle={taskTitle}
      currentColumn={currentColumn}
      currentIndex={currentIndex}
      currentColumnTaskCount={currentTaskIds.length}
      destinationColumns={destinationColumns}
      onMove={context.moveTask}
      isVisibleAfterMove={(command) =>
        context.isTaskVisibleAfterMove?.(
          command.taskId,
          command.toColumnId,
        ) ?? true
      }
      boardHeadingRef={context.boardHeadingRef}
      onAnnounce={context.onAnnounce}
      disabled={context.pendingTaskIds.size > 0}
      positionMovesEnabled={context.positionMovesEnabled}
      registerTrigger={context.registerTrigger}
      requestFocus={context.requestFocus}
    />
  );
}

interface MenuMove {
  command: TaskMoveMenuCommand;
  destinationName: string;
  position: number;
  total: number;
}

export function TaskMoveMenu({
  taskId,
  taskTitle,
  currentColumn,
  currentIndex,
  currentColumnTaskCount,
  destinationColumns,
  onMove,
  isVisibleAfterMove = () => true,
  boardHeadingRef,
  onAnnounce,
  disabled = false,
  positionMovesEnabled = true,
  registerTrigger,
  requestFocus,
}: TaskMoveMenuProps): React.ReactElement {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusAfterCloseRef = useRef<HTMLElement | null>(null);
  const moveOwnsCloseFocusRef = useRef(false);
  const [localAnnouncement, setLocalAnnouncement] = useState("");
  const isFirst = !positionMovesEnabled || currentIndex <= 0;
  const isLast =
    !positionMovesEnabled ||
    currentColumnTaskCount <= 1 ||
    currentIndex >= currentColumnTaskCount - 1;

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger || !registerTrigger) {
      return;
    }
    return registerTrigger(taskId, trigger);
  }, [registerTrigger, taskId]);

  const publishAnnouncement = (message: string) => {
    if (onAnnounce) {
      onAnnounce(message);
    } else {
      setLocalAnnouncement(message);
    }
  };

  const submitMove = async ({
    command,
    destinationName,
    position,
    total,
  }: MenuMove) => {
    const willRemainVisible = isVisibleAfterMove(command);
    const focusRequest: TaskMoveFocusRequest = {
      taskId,
      target: willRemainVisible ? "trigger" : "board-heading",
    };
    const focusTarget = willRemainVisible
      ? triggerRef.current
      : boardHeadingRef?.current ?? null;
    focusAfterCloseRef.current = requestFocus ? null : focusTarget;
    moveOwnsCloseFocusRef.current = Boolean(requestFocus);

    try {
      const move = onMove(command);
      requestFocus?.(focusRequest);
      await move;
      publishAnnouncement(
        announceMove({
          title: taskTitle,
          fromColumn: currentColumn.name,
          toColumn: destinationName,
          position,
          total,
        }),
      );
      if (requestFocus) {
        requestFocus(focusRequest);
      } else {
        queueMicrotask(() => focusTarget?.focus());
      }
    } catch (error) {
      publishAnnouncement(announceMoveError(taskTitle, error));
      if (requestFocus) {
        requestFocus({ taskId, target: "trigger" });
      } else {
        queueMicrotask(() => triggerRef.current?.focus());
      }
    }
  };

  const moveWithinColumn = (targetIndex: number, position: number) => {
    void submitMove({
      command: {
        taskId,
        toColumnId: currentColumn.id,
        targetIndex,
      },
      destinationName: currentColumn.name,
      position,
      total: currentColumnTaskCount,
    });
  };

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon"
            data-no-drag
            aria-label={`Действия задачи «${taskTitle}»`}
            disabled={disabled}
            className="relative h-11 w-11 rounded-lg text-muted-foreground hover:bg-transparent before:pointer-events-none before:absolute before:inset-2 before:rounded-lg before:transition-colors hover:before:bg-accent"
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal className="relative z-10 h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          collisionPadding={8}
          className="w-[min(16rem,calc(100vw-1rem))] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overscroll-contain [&_[role=menuitem]]:min-h-11 [&_[role=menuitem]]:min-w-0 [&_[role=menuitem]]:whitespace-normal [&_[role=menuitem]]:[overflow-wrap:anywhere]"
          onClick={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            if (moveOwnsCloseFocusRef.current) {
              event.preventDefault();
              moveOwnsCloseFocusRef.current = false;
              return;
            }
            const focusTarget = focusAfterCloseRef.current;
            if (!focusTarget) {
              // Non-modal dismissal preserves a clicked outside control's
              // focus. Restore the trigger only when dismissal left no target.
              queueMicrotask(() => {
                if (document.activeElement === document.body) {
                  triggerRef.current?.focus();
                }
              });
              return;
            }
            event.preventDefault();
            focusAfterCloseRef.current = null;
            queueMicrotask(() => focusTarget.focus());
          }}
        >
          <DropdownMenuLabel>Изменить позицию</DropdownMenuLabel>
          <DropdownMenuItem
            disabled={isFirst}
            onSelect={() => moveWithinColumn(0, 1)}
          >
            В начало
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isFirst}
            onSelect={() =>
              moveWithinColumn(currentIndex - 1, currentIndex)
            }
          >
            Выше
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isLast}
            onSelect={() =>
              moveWithinColumn(currentIndex + 1, currentIndex + 2)
            }
          >
            Ниже
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isLast}
            onSelect={() =>
              moveWithinColumn(
                Math.max(0, currentColumnTaskCount - 1),
                currentColumnTaskCount,
              )
            }
          >
            В конец
          </DropdownMenuItem>

          {destinationColumns.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Переместить в колонку</DropdownMenuLabel>
              {destinationColumns.map((column) => (
                <DropdownMenuItem
                  key={column.id}
                  onSelect={() => {
                    void submitMove({
                      command: {
                        taskId,
                        toColumnId: column.id,
                        targetIndex: column.taskCount,
                      },
                      destinationName: column.name,
                      position: column.taskCount + 1,
                      total: column.taskCount + 1,
                    });
                  }}
                >
                  <span className="min-w-0 [overflow-wrap:anywhere]">В колонку «{column.name}»</span>
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {!onAnnounce ? (
        <span role="status" aria-live="polite" className="sr-only">
          {localAnnouncement}
        </span>
      ) : null}
    </>
  );
}
