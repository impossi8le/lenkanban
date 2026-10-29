import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";
import { FilterBar } from "./FilterBar";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const columns = [
  { id: "todo", name: "К выполнению" },
  { id: "done", name: "Готово" },
];

const members = [
  { userId: "u1", user: { name: "Анна", email: "anna@example.test" } },
];

const tags = [
  { id: "t1", name: "Баг", color: "#ef4444" },
  { id: "t2", name: "Фича", color: "#22c55e" },
  { id: "t3", name: "Документация", color: "#3b82f6" },
];

interface ControlledFilterBarProps
  extends Partial<ComponentProps<typeof FilterBar>> {
  initialStatus?: string | null;
  initialPriority?: string | null;
  initialAssignee?: string | null;
  initialTags?: string[] | null;
  initialSortBy?: string;
}

function ControlledFilterBar({
  initialStatus = null,
  initialPriority = null,
  initialAssignee = null,
  initialTags = null,
  initialSortBy = "position",
  onStatusChange,
  onPriorityChange,
  onAssigneeChange,
  onTagsChange,
  onSortChange,
}: ControlledFilterBarProps) {
  const [values, setValues] = useState({
    status: initialStatus,
    priority: initialPriority,
    assignee: initialAssignee,
    tags: initialTags,
    sortBy: initialSortBy,
  });

  return (
    <FilterBar
      status={values.status}
      priority={values.priority}
      assignee={values.assignee}
      tags={values.tags}
      sortBy={values.sortBy}
      columns={columns}
      projectMembers={members}
      projectTags={tags}
      showSort={false}
      onStatusChange={(status) => {
        setValues((v) => ({ ...v, status }));
        onStatusChange?.(status);
      }}
      onPriorityChange={(priority) => {
        setValues((v) => ({ ...v, priority }));
        onPriorityChange?.(priority);
      }}
      onAssigneeChange={(assignee) => {
        setValues((v) => ({ ...v, assignee }));
        onAssigneeChange?.(assignee);
      }}
      onTagsChange={(tags) => {
        setValues((v) => ({ ...v, tags }));
        onTagsChange?.(tags);
      }}
      onSortChange={(sortBy) => {
        setValues((v) => ({ ...v, sortBy }));
        onSortChange?.(sortBy);
      }}
    />
  );
}

function mount(props: ControlledFilterBarProps = {}) {
  const handlers = {
    onStatusChange: vi.fn(),
    onPriorityChange: vi.fn(),
    onAssigneeChange: vi.fn(),
    onTagsChange: vi.fn(),
    onSortChange: vi.fn(),
  };
  render(<ControlledFilterBar {...handlers} {...props} />);
  return handlers;
}

describe("FilterBar multi-tag filter", () => {
  it("selects multiple tags one by one", async () => {
    const user = userEvent.setup();
    const handlers = mount();
    await user.click(screen.getByRole("button", { name: "Фильтр по тегам" }));
    const popover = screen.getByRole("dialog");
    await user.click(within(popover).getByText("Баг"));
    expect(handlers.onTagsChange).toHaveBeenLastCalledWith(["t1"]);

    await user.click(within(popover).getByText("Фича"));
    expect(handlers.onTagsChange).toHaveBeenLastCalledWith(["t1", "t2"]);
  });

  it("toggles an already selected tag off", async () => {
    const user = userEvent.setup();
    const handlers = mount();
    await user.click(screen.getByRole("button", { name: "Фильтр по тегам" }));
    const popover = screen.getByRole("dialog");
    await user.click(within(popover).getByText("Баг"));
    await user.click(within(popover).getByText("Баг"));
    expect(handlers.onTagsChange).toHaveBeenLastCalledWith(null);
  });

  it("clears all tag selections with the 'Все теги' option", async () => {
    const user = userEvent.setup();
    const handlers = mount();
    await user.click(screen.getByRole("button", { name: "Фильтр по тегам" }));
    const popover = screen.getByRole("dialog");
    await user.click(within(popover).getByText("Баг"));
    await user.click(within(popover).getByText("Все теги"));
    expect(handlers.onTagsChange).toHaveBeenLastCalledWith(null);
  });

  it("clears every active filter from the reset button", async () => {
    const user = userEvent.setup();
    const handlers = mount({
      initialStatus: "todo",
      initialPriority: "HIGH",
      initialAssignee: "u1",
      initialTags: ["t1", "t2"],
    });
    await user.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    expect(handlers.onStatusChange).toHaveBeenCalledWith(null);
    expect(handlers.onPriorityChange).toHaveBeenCalledWith(null);
    expect(handlers.onAssigneeChange).toHaveBeenCalledWith(null);
    expect(handlers.onTagsChange).toHaveBeenCalledWith(null);
  });

  it("shows the count of selected tags on the trigger", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Фильтр по тегам" }));
    const popover = screen.getByRole("dialog");
    await user.click(within(popover).getByText("Баг"));
    await user.click(within(popover).getByText("Документация"));
    expect(screen.getByRole("button", { name: "Фильтр по тегам" })).toHaveTextContent("2");
  });
});
