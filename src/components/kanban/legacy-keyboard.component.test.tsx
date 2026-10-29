import { KeyboardSensor } from "@dnd-kit/core";
import { afterEach, expect, it, vi } from "vitest";
import { legacyKeyboardCoordinates } from "./legacy-keyboard";
import { planLegacyMove } from "./legacy-move";

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

it.each([
  { taskId: "b", direction: "ArrowDown", repeats: 1, before: "c", after: "a" },
  { taskId: "a", direction: "ArrowUp", repeats: 1, before: "b", after: "c" },
  { taskId: "b", direction: "ArrowDown", repeats: 2, before: "a", after: null },
  { taskId: "a", direction: "ArrowUp", repeats: 2, before: null, after: "b" },
  { taskId: "b", direction: "ArrowDown", repeats: 1, reverse: true, before: null, after: null },
  { taskId: "a", direction: "ArrowUp", repeats: 1, reverse: true, before: null, after: null },
])("KeyboardSensor moves $taskId $direction $repeats times (reverse=$reverse) across unequal heights with different scroll ancestors", ({ taskId, direction, repeats, reverse, before, after }) => {
  vi.useFakeTimers();
  const tasks = [
    { id: "b", columnId: "one", position: 1024 },
    { id: "c", columnId: "one", position: 2048 },
    { id: "a", columnId: "one", position: 3072 },
  ];
  const rects = new Map([
    ["b", { left: 250, top: 253, width: 300, height: 94, right: 550, bottom: 347 }],
    ["c", { left: 250, top: 359, width: 300, height: 256, right: 550, bottom: 615 }],
    ["a", { left: 250, top: 627, width: 300, height: 132, right: 550, bottom: 759 }],
  ]);
  const scrollContainer = document.createElement("div");
  scrollContainer.style.overflowY = "auto";
  document.body.append(scrollContainer);
  const entries = tasks.map((task, index) => {
    const node = document.createElement("div");
    node.scrollIntoView = () => {};
    scrollContainer.append(node);
    return { id: task.id, key: task.id, disabled: false, node: { current: node }, rect: { current: rects.get(task.id)! }, data: { current: { type: "Task", sortable: { containerId: "one", index, items: ["b", "c", "a"] } } } };
  });
  const containers = Object.assign(new Map(entries.map(entry => [entry.id, entry])), { getEnabled: () => entries });
  const initialRect = rects.get(taskId)!;
  // The dragged source can temporarily remeasure at a different placeholder
  // height. It must never become its own directional navigation target.
  rects.set(taskId, { ...initialRect, height: 100, bottom: initialRect.top + 100 });
  const node = containers.get(taskId)!.node.current;
  const event = new KeyboardEvent("keydown", { code: "Space", bubbles: true });
  node.dispatchEvent(event);
  const context = { current: {
    active: { id: taskId, data: containers.get(taskId)!.data, rect: { current: { initial: initialRect, translated: initialRect } } },
    collisionRect: initialRect, droppableRects: rects, droppableContainers: containers,
    over: null, scrollableAncestors: [],
  } };
  let destinationCenter = initialRect.top + initialRect.height / 2;
  const props = {
    active: taskId, activeNode: { id: taskId, key: taskId, node: { current: node }, activatorNode: { current: node }, data: containers.get(taskId)!.data },
    event, context, options: { coordinateGetter: legacyKeyboardCoordinates },
    onStart: () => {}, onAbort: () => {}, onPending: () => {}, onCancel: () => {}, onEnd: () => {},
    onMove: (delta: { x: number; y: number }) => {
      destinationCenter = initialRect.top + delta.y + initialRect.height / 2;
      context.current.collisionRect = { ...initialRect, top: initialRect.top + delta.y, bottom: initialRect.bottom + delta.y };
    },
  };
  new KeyboardSensor(props as unknown as ConstructorParameters<typeof KeyboardSensor>[0]);
  vi.advanceTimersByTime(0);
  for (let index = 0; index < repeats; index++) {
    document.dispatchEvent(new KeyboardEvent("keydown", { code: direction, bubbles: true }));
  }
  if (reverse) {
    document.dispatchEvent(new KeyboardEvent("keydown", { code: direction === "ArrowDown" ? "ArrowUp" : "ArrowDown", bubbles: true }));
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
  const plan = planLegacyMove({ tasks, taskId, toColumnId: "one", centerY: destinationCenter, rects });
  if (reverse) expect(plan).toBeNull();
  else expect(plan).toMatchObject({ beforeTaskId: before, afterTaskId: after });
});
