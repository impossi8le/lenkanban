import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KanbanCardView, type TaskType } from "@/components/kanban/Card";
import { KanbanCardOverlay } from "@/features/kanban/dnd/KanbanCardOverlay";
import { TaskDetailPanel } from "./TaskDetailPanel";

const preference = vi.hoisted(() => ({ reduce: true }));
vi.mock("motion/react", async () => {
  const React = await import("react");
  const component = (tag: string) => React.forwardRef<HTMLElement, Record<string, unknown>>(function Motion({ initial, animate, exit, transition, ...props }, ref) {
    delete props.whileTap;
    return React.createElement(tag, { ...props, ref, "data-motion": JSON.stringify({ initial, animate, exit, transition }) });
  });
  return { useReducedMotion: () => preference.reduce, AnimatePresence: ({ children }: { children: React.ReactNode }) => children, motion: { div: component("div"), aside: component("aside"), button: component("button") } };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "synthetic" } } }) }));
vi.mock("@/hooks/useTaskDraft", () => ({ useTaskDraft: () => ({ ready: true, recovery: null, change: vi.fn(), acknowledge: vi.fn() }) }));
vi.mock("@/components/task/ActivityTimeline", () => ({ ActivityTimeline: () => null }));
vi.mock("@/components/task/TaskAttachments", () => ({ TaskAttachments: () => null }));
vi.mock("@/components/task/TaskChecklist", () => ({ TaskChecklist: () => null }));
vi.mock("@/components/task/TaskRelatedRequests", () => ({ TaskRelatedRequests: () => null }));
vi.mock("@/components/task/TagPicker", () => ({ TagPicker: () => null }));
vi.mock("@/components/task/AssigneeSelector", () => ({ AssigneeSelector: () => null }));
vi.mock("@/components/task/TaskColumnSelector", () => ({ TaskColumnSelector: () => null }));
vi.mock("@/components/task/TaskRequestLifecycleControls", () => ({ TaskRequestLifecycleControls: () => null }));
vi.mock("@/components/templates/TemplateDialog", () => ({ TemplateDialog: () => null }));
const task: TaskType = { id: "synthetic", title: "Задача", projectId: "synthetic", columnId: "todo", priority: "MEDIUM", position: 1024, assignees: [], tags: [], attachments: [], checklistItems: [] };
const motion = (el: Element) => JSON.parse(el.getAttribute("data-motion")!);
afterEach(() => { cleanup(); preference.reduce = true; });

describe("task presentation motion", () => {
  it.each([true, false])("renders the card immediately without animation for reducedMotion=%s", reduce => {
    preference.reduce = reduce;
    const { container } = render(<KanbanCardView task={task} />);
    const card = container.querySelector('[data-task-id="synthetic"]');
    expect(card).toBeVisible();
    expect(card).not.toHaveAttribute("data-motion");
    expect(card).not.toHaveStyle({ opacity: "0" });
    expect(card).not.toHaveStyle({ transform: "translateY(12px)" });
    expect(screen.getByText("Задача")).toBeVisible();
  });
  it("keeps the generic overlay presentation static without draggable controls", () => {
    preference.reduce = false;
    const { container } = render(<KanbanCardOverlay task={task} />);
    expect(screen.getByText("Задача")).toBeVisible();
    expect(container.querySelector("[data-motion]")).toBeNull();
    expect(container.querySelector("[data-kanban-drag-handle]")).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("opens the reduced-motion dialog immediately and removes spatial exit", () => {
    render(<TaskDetailPanel task={task} onClose={() => {}} onSave={() => {}} />);
    const props = motion(screen.getByRole("dialog"));
    expect(props.initial).toBe(false);
    expect(props.transition.duration).toBe(0);
    expect(props.exit).toEqual({ opacity: 1 });
  });
  it("uses a short opacity transition without shifting the centered dialog", () => {
    preference.reduce = false;
    render(<TaskDetailPanel task={task} onClose={() => {}} onSave={() => {}} />);
    const props = motion(screen.getByRole("dialog"));
    expect(props.initial).toEqual({ opacity: 0 });
    expect(props.transition.duration).toBe(0.15);
    expect(screen.getByRole("dialog")).toHaveClass("left-1/2", "top-1/2", "max-w-[740px]");
    expect(props.exit).toEqual({ opacity: 0 });
  });
});
