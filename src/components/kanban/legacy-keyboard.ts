import type { KeyboardCoordinateGetter } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

// The stock getter can align top edges when scroll ancestors differ. For
// variable-height cards that does not necessarily cross the insertion midpoint.
export const legacyKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  if (event.code !== "ArrowDown" && event.code !== "ArrowUp") {
    return sortableKeyboardCoordinates(event, args);
  }
  const { collisionRect, droppableContainers, droppableRects } = args.context;
  if (!collisionRect) return;
  event.preventDefault();
  const direction = event.code === "ArrowDown" ? 1 : -1;
  const centerX = collisionRect.left + collisionRect.width / 2;
  const centerY = collisionRect.top + collisionRect.height / 2;
  let nearest: { center: number; distance: number } | undefined;
  for (const container of droppableContainers.getEnabled()) {
    if (container.id === args.active) continue;
    if (container.data.current?.type !== "Task") continue;
    const rect = droppableRects.get(container.id);
    if (!rect || centerX < rect.left || centerX > rect.left + rect.width) continue;
    const center = rect.top + rect.height / 2;
    const distance = (center - centerY) * direction;
    if (distance > 0.1 && (!nearest || distance < nearest.distance)) {
      nearest = { center, distance };
    }
  }
  if (!nearest) return;
  return {
    x: args.currentCoordinates.x,
    // Cross the midpoint in the requested direction, avoiding rounding ties.
    y: nearest.center + direction - collisionRect.height / 2,
  };
};
