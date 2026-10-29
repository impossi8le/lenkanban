import { useRef, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it } from "vitest";
import {
  KanbanCardView,
  type TaskType,
} from "@/components/kanban/Card";
import {
  ContextualTaskMoveMenu,
  TaskMoveMenu,
  TaskMoveMenuProvider,
  type TaskMoveMenuCommand,
} from "./TaskMoveMenu";

const destinationColumns = [
  { id: "review", name: "Проверка", taskCount: 1 },
  { id: "done", name: "Готово", taskCount: 0 },
];

const baseProps = {
  taskId: "task-internal-42",
  taskTitle: "Исправить авторизацию",
  currentColumn: { id: "doing", name: "В работе" },
  currentIndex: 1,
  currentColumnTaskCount: 3,
  destinationColumns,
};

const contextualState = {
  columnOrder: ["todo", "doing"],
  taskIdsByColumn: {
    todo: ["a", "task-internal-42", "b"],
    doing: [],
  },
  tasksById: {
    a: { id: "a", columnId: "todo", position: 1024, version: 1 },
    "task-internal-42": {
      id: "task-internal-42",
      columnId: "todo",
      position: 2048,
      version: 1,
    },
    b: { id: "b", columnId: "todo", position: 3072, version: 1 },
  },
};

afterEach(cleanup);

async function openMenu(): Promise<HTMLButtonElement> {
  const trigger = screen.getByRole("button", {
    name: "Действия задачи «Исправить авторизацию»",
  });
  await userEvent.click(trigger);
  return trigger as HTMLButtonElement;
}

function renderContextualMenuHarness(): {
  announcements: string[];
  commands: TaskMoveMenuCommand[];
} {
  const announcements: string[] = [];
  const commands: TaskMoveMenuCommand[] = [];

  render(
    <TaskMoveMenuProvider
      value={{
        state: contextualState,
        columns: [
          { id: "todo", name: "К выполнению" },
          { id: "doing", name: "В работе" },
        ],
        pendingTaskIds: new Set(),
        moveTask: (command) => {
          commands.push(command);
        },
        onAnnounce: (message) => {
          announcements.push(message);
        },
      }}
    >
      <ContextualTaskMoveMenu
        taskId="task-internal-42"
        taskTitle="Исправить авторизацию"
      />
    </TaskMoveMenuProvider>,
  );

  return { announcements, commands };
}

describe("TaskMoveMenu", () => {
  it("keeps focus on a real outside input when that click dismisses the menu", async () => {
    const user = userEvent.setup();
    render(
      <>
        <TaskMoveMenu {...baseProps} onMove={() => undefined} />
        <input aria-label="Фильтр задач" />
      </>,
    );
    await openMenu();
    const input = screen.getByRole("textbox", { name: "Фильтр задач" });
    await user.click(input);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(input).toHaveFocus();
  });

  it("keeps background controls exposed while preserving menu arrows, Tab and Escape focus", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <TaskMoveMenu {...baseProps} onMove={() => undefined} />
        <main className="min-h-64">
          <button type="button">Новая задача</button>
          <a href="#task">Открыть задачу</a>
          <input aria-label="Фильтр задач" />
        </main>
      </>,
    );
    const trigger = screen.getByRole("button", {
      name: "Действия задачи «Исправить авторизацию»",
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");

    expect(container.querySelector(".min-h-64")?.closest('[aria-hidden="true"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Новая задача" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Открыть задачу" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Фильтр задач" })).toBeVisible();
    const first = screen.getByRole("menuitem", { name: "В начало" });
    const second = screen.getByRole("menuitem", { name: "Выше" });
    await waitFor(() => expect(first).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(second).toHaveFocus();
    await user.tab();
    expect(second).toHaveFocus();
    expect(screen.getByRole("menu")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.tab();
    expect(screen.getByRole("button", { name: "Новая задача" })).toHaveFocus();
  });

  it("gives the action trigger a task-specific accessible name", () => {
    render(<TaskMoveMenu {...baseProps} onMove={() => undefined} />);

    const trigger = screen.getByRole("button", {
      name: "Действия задачи «Исправить авторизацию»",
    });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveClass("h-11", "w-11", "hover:bg-transparent");
    expect(trigger).not.toHaveClass("-m-2");
  });

  it("lists every destination column", async () => {
    render(<TaskMoveMenu {...baseProps} onMove={() => undefined} />);

    await openMenu();

    expect(
      screen.getByRole("menuitem", { name: "В колонку «Проверка»" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "В колонку «Готово»" }),
    ).toBeInTheDocument();
  });

  it("disables beginning and upward movement at the first position", async () => {
    render(
      <TaskMoveMenu
        {...baseProps}
        currentIndex={0}
        onMove={() => undefined}
      />,
    );

    await openMenu();

    expect(screen.getByRole("menuitem", { name: "В начало" })).toHaveAttribute(
      "data-disabled",
    );
    expect(screen.getByRole("menuitem", { name: "Выше" })).toHaveAttribute(
      "data-disabled",
    );
    expect(screen.getByRole("menuitem", { name: "Ниже" })).not.toHaveAttribute(
      "data-disabled",
    );
    expect(screen.getByRole("menuitem", { name: "В конец" })).not.toHaveAttribute(
      "data-disabled",
    );
  });

  it("disables downward and ending movement at the last position", async () => {
    render(
      <TaskMoveMenu
        {...baseProps}
        currentIndex={2}
        onMove={() => undefined}
      />,
    );

    await openMenu();

    expect(screen.getByRole("menuitem", { name: "В начало" })).not.toHaveAttribute(
      "data-disabled",
    );
    expect(screen.getByRole("menuitem", { name: "Выше" })).not.toHaveAttribute(
      "data-disabled",
    );
    expect(screen.getByRole("menuitem", { name: "Ниже" })).toHaveAttribute(
      "data-disabled",
    );
    expect(screen.getByRole("menuitem", { name: "В конец" })).toHaveAttribute(
      "data-disabled",
    );
  });

  it("submits one semantic destination command", async () => {
    const commands: TaskMoveMenuCommand[] = [];
    render(
      <TaskMoveMenu
        {...baseProps}
        onMove={(command) => {
          commands.push(command);
        }}
      />,
    );

    await openMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: "В колонку «Проверка»" }),
    );

    expect(commands).toEqual([
      {
        taskId: "task-internal-42",
        toColumnId: "review",
        targetIndex: 1,
      },
    ]);
  });

  it("returns focus to the action trigger when the task stays visible", async () => {
    render(<TaskMoveMenu {...baseProps} onMove={() => Promise.resolve()} />);

    const trigger = await openMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: "В колонку «Проверка»" }),
    );

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("announces a 409 conflict and restores focus to the action trigger", async () => {
    const conflict = Object.assign(new Error("stale version"), {
      status: 409,
      payload: {
        error: {
          code: "STALE_TASK_VERSION",
        },
      },
    });
    render(
      <TaskMoveMenu
        {...baseProps}
        onMove={() => Promise.reject(conflict)}
      />,
    );

    const trigger = await openMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: "В колонку «Проверка»" }),
    );

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Не удалось сохранить перемещение задачи «Исправить авторизацию»: " +
        "задачу уже изменили. Порядок восстановлен. Обновите доску и повторите попытку.",
    );
  });

  it("focuses the board heading and announces a move that filters the task out", async () => {
    function Harness(): React.ReactElement {
      const headingRef = useRef<HTMLHeadingElement>(null);
      const [announcement, setAnnouncement] = useState("");

      return (
        <>
          <h2 ref={headingRef} tabIndex={-1}>
            Канбан-доска
          </h2>
          <TaskMoveMenu
            {...baseProps}
            boardHeadingRef={headingRef}
            isVisibleAfterMove={() => false}
            onAnnounce={setAnnouncement}
            onMove={() => Promise.resolve()}
          />
          <div role="status" aria-live="polite">
            {announcement}
          </div>
        </>
      );
    }

    render(<Harness />);
    await openMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: "В колонку «Проверка»" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Канбан-доска" })).toHaveFocus(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Задача «Исправить авторизацию» перемещена из «В работе» " +
        "в «Проверка», позиция 2 из 2.",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "task-internal-42",
    );
  });

  it("has no serious or critical axe violations while open", async () => {
    render(<TaskMoveMenu {...baseProps} onMove={() => undefined} />);

    const trigger = screen.getByRole("button", {
      name: "Действия задачи «Исправить авторизацию»",
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });

    await screen.findByRole("menu");
    const results = await axe(document.body);

    expect(
      results.violations.filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      ),
    ).toEqual([]);
  });
});

describe("ContextualTaskMoveMenu integration contract", () => {
  it("returns focus to the trigger when Escape dismisses the menu", async () => {
    const { announcements, commands } = renderContextualMenuHarness();
    const trigger = await openMenu();

    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(commands).toEqual([]);
    expect(announcements).toEqual([]);
  });

  it("returns focus to the trigger when an outside click dismisses the menu", async () => {
    const { announcements, commands } = renderContextualMenuHarness();
    const trigger = await openMenu();

    fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });
    fireEvent.click(document.body);

    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(commands).toEqual([]);
    expect(announcements).toEqual([]);
  });

  it("keeps the drag overlay presentation-only inside the provider", () => {
    const overlayTask: TaskType = {
      id: "task-internal-42",
      title: "Исправить авторизацию",
      columnId: "todo",
      priority: "HIGH",
      position: 2048,
      projectId: "project-1",
      version: 1,
    };

    render(
      <TaskMoveMenuProvider
        value={{
          state: contextualState,
          columns: [
            { id: "todo", name: "К выполнению" },
            { id: "doing", name: "В работе" },
          ],
          pendingTaskIds: new Set(),
          moveTask: () => undefined,
        }}
      >
        <aside data-testid="drag-overlay">
          <KanbanCardView task={overlayTask} />
        </aside>
      </TaskMoveMenuProvider>,
    );

    expect(
      screen.queryByRole("button", {
        name: "Действия задачи «Исправить авторизацию»",
      }),
    ).not.toBeInTheDocument();
  });

  it("renders no competing action trigger outside the modern provider", () => {
    render(
      <ContextualTaskMoveMenu
        taskId="task-internal-42"
        taskTitle="Исправить авторизацию"
      />,
    );

    expect(
      screen.queryByRole("button", {
        name: "Действия задачи «Исправить авторизацию»",
      }),
    ).not.toBeInTheDocument();
  });

  it("renders exactly one action trigger inside the modern provider", () => {
    render(
      <TaskMoveMenuProvider
        value={{
          state: contextualState,
          columns: [
            { id: "todo", name: "К выполнению" },
            { id: "doing", name: "В работе" },
          ],
          pendingTaskIds: new Set(),
          moveTask: () => undefined,
        }}
      >
        <ContextualTaskMoveMenu
          taskId="task-internal-42"
          taskTitle="Исправить авторизацию"
        />
      </TaskMoveMenuProvider>,
    );

    expect(
      screen.getAllByRole("button", {
        name: "Действия задачи «Исправить авторизацию»",
      }),
    ).toHaveLength(1);
  });

  it("disables the action trigger while a coordinated move is pending", () => {
    render(
      <TaskMoveMenuProvider
        value={{
          state: contextualState,
          columns: [
            { id: "todo", name: "К выполнению" },
            { id: "doing", name: "В работе" },
          ],
          pendingTaskIds: new Set(["task-internal-42"]),
          moveTask: () => undefined,
        }}
      >
        <ContextualTaskMoveMenu
          taskId="task-internal-42"
          taskTitle="Исправить авторизацию"
        />
      </TaskMoveMenuProvider>,
    );

    expect(
      screen.getByRole("button", {
        name: "Действия задачи «Исправить авторизацию»",
      }),
    ).toBeDisabled();
  });

  it("keeps destination moves available but disables ambiguous position moves under filters or alternate sorting", async () => {
    render(
      <TaskMoveMenuProvider
        value={{
          state: contextualState,
          columns: [
            { id: "todo", name: "К выполнению" },
            { id: "doing", name: "В работе" },
          ],
          pendingTaskIds: new Set(),
          positionMovesEnabled: false,
          moveTask: () => undefined,
        }}
      >
        <ContextualTaskMoveMenu
          taskId="task-internal-42"
          taskTitle="Исправить авторизацию"
        />
      </TaskMoveMenuProvider>,
    );

    await openMenu();

    for (const name of ["В начало", "Выше", "Ниже", "В конец"]) {
      expect(screen.getByRole("menuitem", { name })).toHaveAttribute(
        "data-disabled",
      );
    }
    expect(
      screen.getByRole("menuitem", { name: "В колонку «В работе»" }),
    ).not.toHaveAttribute("data-disabled");
  });
});
