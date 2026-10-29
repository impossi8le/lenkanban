import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { KanbanCard } from "./Card";

const measurement = vi.hoisted(() => ({ height: 94.25, initialHeight: null as number | null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@dnd-kit/sortable", () => ({ useSortable: () => ({
  setNodeRef: () => {}, attributes: {}, listeners: {}, transform: null,
  transition: undefined, isDragging: true,
  rect: { current: { height: measurement.height } },
  active: { rect: { current: { initial: measurement.initialHeight === null ? null : { height: measurement.initialHeight } } } },
}) }));
afterEach(cleanup);

it.each([94.25, 256.5])("keeps task content available without a manual drag placeholder at measured height %s", height => {
  measurement.height = height;
  measurement.initialHeight = null;
  const { container } = render(<KanbanCard task={{
    id: "task", title: "Task", projectId: "project", columnId: "column",
    position: 1024, priority: "MEDIUM",
  }} />);
  expect(container.querySelector(".border-dashed")).toBeNull();
  expect(screen.getByRole("button", { name: "Открыть задачу «Task»" })).toBeVisible();
  expect(container.querySelector("[data-kanban-drag-handle]")).toBeNull();
});

it("does not replace task content when stale sortable measurements change", () => {
  measurement.height = 100;
  measurement.initialHeight = 256.5;
  const { container } = render(<KanbanCard task={{ id: "task", title: "Task", projectId: "project", columnId: "column", position: 1024, priority: "MEDIUM" }} />);
  expect(container.querySelector(".border-dashed")).toBeNull();
  expect(screen.getByRole("button", { name: "Открыть задачу «Task»" })).toBeVisible();
});
