import { cleanup, render, screen, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { afterEach, expect, it, vi } from "vitest";
import { KanbanColumn } from "./Column";
import type { TaskType } from "./Card";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(cleanup);

const task: TaskType = {
  id: "moved-task", title: "Moved card", projectId: "project",
  columnId: "source", position: 1024, priority: "MEDIUM",
};
function Columns({ moved }: { moved: boolean }) {
  return <DndContext>
    <div role="region" aria-label="Source">
      <KanbanColumn id="source" title="Source column" color="#777777" tasks={moved ? [] : [task]} onCreateTask={() => {}} />
    </div>
    <div role="region" aria-label="Destination">
      <KanbanColumn id="destination" title="Destination column" color="#777777" tasks={moved ? [{ ...task, columnId: "destination" }] : []} onCreateTask={() => {}} />
    </div>
  </DndContext>;
}

it("unmounts a transferred sortable card from its source instead of retaining an exit ghost", () => {
  const { rerender } = render(<Columns moved={false} />);
  expect(within(screen.getByRole("region", { name: "Source" })).getByText("Moved card")).toBeInTheDocument();

  rerender(<Columns moved />);

  expect(within(screen.getByRole("region", { name: "Source" })).queryByText("Moved card")).toBeNull();
  expect(within(screen.getByRole("region", { name: "Destination" })).getByText("Moved card")).toBeInTheDocument();
  expect(screen.getAllByText("Moved card")).toHaveLength(1);
});
