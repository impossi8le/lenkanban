> Исторический документ. При сверке 20.10.2026 содержание сохранено как запись на исходную дату; результаты и планы не перепроверялись. Актуальная навигация: [статус документации](../../DOCUMENTATION_STATUS.md).

# Kanban Drag-and-Drop Modernization Design

**Date:** 2026-07-28

**Status:** Approved design, pending written-spec review

**Repository baseline:** `lenremont2/kanban_lr` at `ee2a0cd34062cdaf52176ce77ff8eb74fff98fb7`

## Objective

Make task movement correct, durable, responsive, and accessible across columns and within a column. The work must also repair the board's light/dark theme contract because the current dark theme makes several cards unreadable and prevents reliable visual verification of drag states.

This is the first modernization sub-project. Broader security, dependency, realtime, mobile task-detail, and repository-wide type/lint cleanup remain separate follow-up sub-projects so that each can be implemented and rolled back independently.

## Confirmed Production Failures

The following behaviors were reproduced in the in-app browser against the dedicated E2E project:

1. A same-column drag changes the optimistic order, but a reload restores the old server order.
2. A cross-column drag persists, but the client can temporarily display a different order from the authoritative order.
3. `Space` on a task card opens task details instead of starting keyboard drag-and-drop.
4. The live region announces internal database IDs in English.
5. A task can appear in the board's “В работе” column while the table reports “К выполнению”, proving that `columnId` and `status` are conflicting workflow sources.
6. The selected dark theme produces near-white text on pale priority backgrounds.
7. The current client performs multi-request rebalance and has no command version, idempotency key, transactional rollback, or stale-event reconciliation.

All production test mutations were reversed, and the original task counts, order, and theme were restored.

## Scope

### Included

- Canonical workflow state based on `Task.columnId`.
- A pure, library-independent task movement planner.
- Server-owned rank generation and atomic movement.
- Optimistic state with snapshot rollback and conflict recovery.
- Migration of the board task DnD adapter to the stable `@dnd-kit/*` 0.5.0 packages.
- Pointer, touch, and keyboard interactions.
- A click/tap alternative to dragging.
- Russian screen-reader announcements without internal IDs.
- Board light, dark, and system themes with valid semantic tokens.
- Reduced-motion behavior.
- Unit, route/service, component, accessibility, and browser regression tests for this sub-project.

### Excluded

- Full offline-first sync or CRDT replication.
- Multi-card drag.
- Swimlanes and tree/group drag.
- Rewriting column-reorder DnD.
- Repository-wide API or component refactoring unrelated to task movement.
- Production deployment.
- Upload, Socket.IO, cron, and dependency-security fixes; these will receive a separate security/reliability spec.

## Architectural Decision

Use a two-layer design:

1. A domain and server movement contract that is independent of any DnD library.
2. A replaceable UI adapter built on `@dnd-kit/react` 0.5.0.

This order prevents a library migration from preserving the existing position, rollback, and concurrency defects. The board will migrate to the new dnd-kit API, while unrelated legacy DnD consumers may temporarily keep `@dnd-kit/core` until their own migration is planned.

## Domain Model

### Canonical workflow state

`Task.columnId` is the only field that determines the task's board column.

Add `ProjectColumn.workflowKey String`. It is immutable after creation and unique within a project. The migration assigns the existing `TODO`, `IN_PROGRESS`, `REVIEW`, and `DONE` values to the first four legacy columns once; additional or newly created columns receive an immutable `COLUMN_<CUID>` key.

The legacy `Task.status` field remains temporarily for API compatibility, but it is derived server-side from the destination column's `workflowKey`. The client cannot update `status` independently of `columnId`. Views and filters use the canonical column relation and display the column name, never an independently mutable status value.

`ProjectColumn.position` controls only visual column order. Reordering columns must not change workflow identity.

### Versioning

Add:

- `Task.version Int @default(0)`
- `Project.boardRevision Int @default(0)`
- `Project.dndV2Enabled Boolean @default(false)`

Every successful task move increments both values in the same transaction. Client commands include the last observed `Task.version`. A stale command receives HTTP `409` with a machine-readable `STALE_TASK_VERSION` code and the authoritative task/board revision.

### Rank storage

Add a server-owned `Task.rank String @db.VarChar(22)` field and retain `Task.position` only as a transitional compatibility field during this sub-project.

Ranks use `0|<core>`, where `<core>` is exactly 20 uppercase base-36 characters (`0-9A-Z`). The database column uses PostgreSQL `COLLATE "C"` so database and application ordering are bytewise and deterministic. The current bucket is fixed at `0`; additional Jira-style buckets are deliberately excluded until production metrics prove that atomic rebalance is insufficient. The UI never creates, edits, or interprets ranks.

The numeric domain for the core is `0` through `36^20 - 1`. `between(null, next)` uses `floor(next / 2)`, `between(previous, null)` uses `floor((previous + max) / 2)`, and two bounded ranks use `floor((previous + next) / 2)`. A gap of one or less returns `null`. Rebalance assigns task `i` the numeric core `floor(max / (taskCount + 1)) * (i + 1)`.

`RankService` exposes:

```ts
export interface RankService {
  between(previous: string | null, next: string | null): string | null;
  rebalance(taskIdsInOrder: readonly string[]): ReadonlyMap<string, string>;
}
```

`between` returns `null` when no representable gap remains. The move transaction then locks the destination column's ordered tasks and applies one atomic rebalance before calculating the final rank. This provides Jira-like sparse ordering without exposing Jira's bucket mechanics to the client.

Rank collisions caused by concurrent inserts are handled by the transaction retry policy and a unique database constraint scoped to a project column.

For rollback compatibility, the same transaction re-derives `Task.position` as `(index + 1) * 1024` for every task in the affected source and destination columns. `position` is never used to calculate the new canonical order. It can be removed only after the legacy board adapter is retired.

## Movement Contract

Create:

```http
POST /api/tasks/:taskId/move
Content-Type: application/json
```

Request:

```ts
export interface MoveTaskRequest {
  toColumnId: string;
  beforeTaskId: string | null;
  afterTaskId: string | null;
  operationId: string;       // UUID
  expectedVersion: number;
}
```

`beforeTaskId` is the immediate task before the desired insertion point. `afterTaskId` is the immediate task after it. Both are `null` only for an empty destination column.

Response:

```ts
export interface MoveTaskResponse {
  operationId: string;
  boardRevision: number;
  task: {
    id: string;
    columnId: string;
    version: number;
    status: string;
  };
}
```

### Validation

The server verifies:

- The caller has write access to the task's project.
- The destination column belongs to the same project.
- Neighbor IDs belong to the destination column and same project.
- After excluding the moving task, the supplied neighbors are adjacent and describe one valid insertion point.
- `expectedVersion` matches the current task version.
- Reuse of an `operationId` has an identical normalized request payload.

Malformed neighbor sets return `422 INVALID_MOVE_NEIGHBORS`. Cross-project input returns `422 INVALID_DESTINATION_COLUMN`. Stale input returns `409 STALE_TASK_VERSION`.

### Idempotency

Add a `TaskMoveOperation` table keyed by `operationId`. It stores the task, normalized request hash, response payload, and creation time.

The operation record and task move are committed together. Retrying the same operation returns the stored response. Reusing an operation ID with a different payload returns `409 OPERATION_ID_REUSED`.

### Transaction

The movement service uses one Prisma transaction with serializable isolation and bounded retry for serialization/unique-rank conflicts.

Within the transaction it:

1. Claims or finds the idempotency record.
2. Locks the task, project revision, destination column, and relevant ordered task rows.
3. Validates access-independent domain invariants.
4. Calculates a rank or atomically rebalances the destination column.
5. Updates `columnId`, derived `status`, transitional `position`, rank, and task version.
6. Increments the project board revision.
7. Stores the operation response.
8. Writes the activity record through the same transaction.

Realtime emission occurs only after commit and includes `operationId`, `task.version`, and `boardRevision`.

## Client State and Data Flow

### Normalized board state

Replace index calculations over the full `Task[]` with:

```ts
export interface KanbanBoardState {
  columnOrder: string[];
  taskIdsByColumn: Record<string, string[]>;
  tasksById: Record<string, Task>;
}
```

The pure function:

```ts
export function planMove(
  state: KanbanBoardState,
  input: {
    taskId: string;
    toColumnId: string;
    targetIndex: number;
  },
): {
  nextState: KanbanBoardState;
  command: Omit<MoveTaskRequest, "operationId" | "expectedVersion">;
};
```

removes the task from its current group, inserts it at a clamped target index, and derives the immediate neighbor IDs from the resulting destination group. It does not read or calculate ranks.

### Optimistic lifecycle

1. Drag start saves an immutable board snapshot and marks board-query synchronization as paused.
2. New dnd-kit's optimistic sorting supplies movement feedback without a React render for every pointer-over event.
3. Drag cancel restores the snapshot and announces cancellation.
4. Drag end calls `planMove`, commits the optimistic state, and submits one movement command.
5. Success merges the authoritative task version and board revision.
6. Network or `5xx` failure restores the snapshot and offers retry.
7. `409` restores/refetches authoritative state and tells the user that another update won the conflict.
8. Query and socket snapshots received during a drag are queued and reconciled after the interaction.

Commands for the same task are serialized client-side. Different tasks may move concurrently.

### Filters and sorting

Manual drag reorder is enabled only when the visible sort mode is “По позиции” and no task filter is active. Other sort modes and filtered results show a disabled drag handle with the explanation “Сбросьте фильтры и выберите сортировку «По позиции», чтобы изменить порядок”.

The click/tap movement menu remains available while filters are active. It plans against the canonical unfiltered board state already held by the client, so “В начало”, “В конец”, and destination-column actions have unambiguous server neighbors.

## DnD Adapter

Use exact stable package versions:

- `@dnd-kit/react@0.5.0`
- `@dnd-kit/dom@0.5.0`
- `@dnd-kit/helpers@0.5.0`
- `@dnd-kit/abstract@0.5.0`
- `@dnd-kit/collision@0.5.0`

The board uses `DragDropProvider`, sortable `group`, per-column low-priority droppable targets, and the default `OptimisticSortingPlugin`.

Split presentation from behavior:

- `KanbanCardView`: visual-only card, no sortable registration.
- `SortableKanbanCard`: registers one sortable task and renders `KanbanCardView`.
- `KanbanCardOverlay`: renders `KanbanCardView` only, preventing duplicate sortable IDs.
- `KanbanColumn`: renders ordered task IDs and an empty-column target.

### Input behavior

- Mouse: a short distance threshold prevents accidental drags.
- Touch: a press delay and tolerance preserve vertical scrolling.
- Interactive children never start a drag.
- The card has a visible/focus-visible drag handle with a minimum 44×44 CSS-pixel target on touch layouts.
- `Escape` cancels and restores the exact snapshot.
- Dropping outside all valid targets cancels instead of using the last sticky column.
- Horizontal board and vertical column auto-scroll are tested at both edges.

## Accessibility

Every card's existing actions menu gains:

```text
Переместить…
  → К выполнению
  → В работе
  → На проверке
  → Готово
  ─────────────
  В начало
  Выше
  Ниже
  В конец
```

Only valid destinations/actions are enabled. These commands use the same `planMove` and server movement endpoint as drag-and-drop.

The interaction provides Russian announcements containing the task title, source column, destination column, and final 1-based position. Database IDs are never announced.

After a menu move, focus returns to the moved card's action trigger when it remains visible. After moving to a filtered-out destination, focus moves to the board heading and the live region explains why.

The implementation targets WCAG 2.2 AA for keyboard access, dragging alternatives, focus visibility, target size, status messages, and reduced motion. Automated checks do not constitute a claim of full WCAG conformance; manual NVDA/VoiceOver testing remains required.

## Theme and Motion Contract

Tailwind 4 dark variants must follow the class controlled by `next-themes`:

```css
@custom-variant dark (&:where(.dark, .dark *));
```

Define complete semantic tokens for both `:root` and `.dark`, including background, foreground, card, card-foreground, muted, muted-foreground, primary, primary-foreground, border, input, and ring.

Priority styling uses semantic foreground/background pairs rather than pale fixed backgrounds with globally inherited text. Drag overlay, target highlight, pending state, conflict state, and success flash must be legible in light, dark, and system themes.

Repair the unclosed CSS rule and replace invalid variable alpha syntax. Add a global reduced-motion contract and configure Motion to respect the user's preference.

Theme switching must persist after reload. The implementation must not alter the user's selected theme during tests without restoring it.

## Testing Strategy

### Unit

Use Vitest for:

- `planMove` within a column, across columns, into an empty column, and at bounds.
- Snapshot immutability and cancel restoration.
- Neighbor derivation after removing the active task.
- Fixed-width rank ordering, midpoint exhaustion, and deterministic rebalance.
- Per-task command serialization.
- Socket/version reconciliation.

Every bug fix begins with a failing test that reproduces the observed behavior.

### Service and route

Test the movement service against an isolated PostgreSQL test database:

- Authorized move and exact resulting order.
- Same-column and cross-column moves.
- Empty destination.
- Invalid/cross-project neighbors.
- Stale task version.
- Duplicate identical operation ID.
- Reused operation ID with different payload.
- Concurrent moves into one gap.
- Atomic rebalance rollback on injected failure.
- Task version and board revision increments.

Tests must never use the production database or production credentials.

### Component and accessibility

Use React Testing Library, user-event, MSW, and axe for:

- Drag handle names and focus visibility.
- `Space`/keyboard behavior.
- Click/tap move menu.
- Focus restoration.
- Cancel and request-failure rollback.
- Russian live-region messages.
- Light/dark semantic contrast assumptions and token presence.
- Reduced-motion mode.

### Browser

Use an isolated local/staging database and the in-app Browser for:

- Exact same-column persistence after reload.
- Cross-column move and return.
- Empty-column drop.
- Drop outside and `Escape`.
- Pointer and touch activation constraints.
- Keyboard/menu alternative.
- Filter/sort restrictions.
- Conflict/rollback UI.
- Light, dark, and system screenshots.
- 1280×720, 390×844, 412×915, and 768×1024 layouts.
- No unexpected console errors or failed movement requests.

Production browser checks remain reversible and limited to the dedicated E2E project.

## Observability

Record structured movement telemetry:

- operation ID
- project ID
- task ID
- source/destination column IDs
- duration
- result (`success`, `conflict`, `invalid`, `error`)
- rebalance flag
- resulting task version and board revision

Do not include task titles, descriptions, user emails, or attachment data.

## Migration and Rollback

1. Add version, revision, rank, and operation schema in an additive migration.
2. Backfill rank by existing `(columnId, position, id)` order.
3. Deploy server support while the legacy PATCH path remains available.
4. Enable `Project.dndV2Enabled` only for the isolated E2E project, then switch enabled projects to the new adapter and movement endpoint.
5. Verify revisions, rank uniqueness, error rate, and browser tests.
6. Remove client-side rebalance and independent status mutation.
7. Remove the legacy movement path only in a later cleanup after production observation.

Rollback disables the feature flag and returns the board to the legacy adapter. Additive schema remains in place, so rollback does not destroy ranks, versions, or operation history.

## Acceptance Criteria

- Same-column and cross-column order persists exactly after reload.
- One drag produces one movement command, except a transparent retry of the same operation ID.
- Client code never calculates or sends a rank.
- Rebalance is atomic and cannot leave partial order updates.
- Stale writes do not silently overwrite newer movement.
- Board and table agree on task workflow state.
- Drag reorder is unavailable when filters are active or sorting is not “По позиции”.
- `Escape`, outside drop, network failure, and conflict restore authoritative state.
- Mouse, touch, keyboard, and click/tap alternatives reach the same movement service.
- Screen-reader messages are Russian and contain no internal IDs.
- Task cards and drag states are readable in light, dark, and system themes.
- Reduced-motion preferences are respected.
- New unit, service, component, accessibility, and browser tests pass in an isolated non-production environment.

## Follow-up Sub-projects

After this sub-project, create separate specs and plans for:

1. Upload and Socket.IO security hardening plus vulnerable dependency upgrades.
2. Repository-wide TypeScript/lint/build-gate restoration and dead-code removal.
3. Mobile header and task-detail redesign.
4. Realtime outbox, recurrence idempotency, and notification reliability.
5. Column reorder transactionality and legacy DnD removal.

