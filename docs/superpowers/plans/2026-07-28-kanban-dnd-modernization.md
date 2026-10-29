> Исторический документ. При сверке 20.10.2026 содержание сохранено как запись на исходную дату; результаты и планы не перепроверялись. Актуальная навигация: [статус документации](../../DOCUMENTATION_STATUS.md).

# Kanban Drag-and-Drop Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kanban task movement exact, transactional, accessible, and visually correct in light and dark themes while preserving a reversible legacy rollout path.

**Architecture:** The implementation separates a library-independent board domain from a server-owned rank/move protocol and a replaceable dnd-kit UI adapter. The server accepts semantic neighbors, calculates canonical ranks in one transaction, versions every move, and exposes one idempotent command; the client uses normalized state, snapshot rollback, and `@dnd-kit/*` 0.5.0.

**Tech Stack:** Next.js 15, React 19, TypeScript 5.8, Prisma 6/PostgreSQL, TanStack Query 5, `@dnd-kit/*` 0.5.0, Vitest, React Testing Library, axe-core, Playwright.

## Global Constraints

- Work only on branch `codex/kanban-modernization`; never mutate production or use production credentials in automated tests.
- Treat `Task.columnId` as the only board-column source of truth; `Task.status` is derived from immutable `ProjectColumn.workflowKey`.
- The browser client never creates, parses, or submits a rank.
- Use `0|<20 uppercase base-36 characters>` ranks stored with PostgreSQL `COLLATE "C"`.
- A task move request is exactly `{ toColumnId, beforeTaskId, afterTaskId, operationId, expectedVersion }`.
- A move is one serializable transaction and one client command; retries reuse the same `operationId`.
- Keep `Task.position` synchronized as `(index + 1) * 1024` only for temporary legacy rollback.
- Keep legacy dnd-kit packages for unrelated column-reorder code; migrate only the task board in this plan.
- Drag reorder is disabled unless sort is `position` and no task filter is active.
- Provide mouse, touch, keyboard, and click/tap movement paths through the same domain command.
- All user-facing movement copy and live-region announcements are Russian and never contain database IDs.
- Respect `prefers-reduced-motion`; theme tests restore the theme that was active before the test.
- Follow strict TDD: add the failing behavior test, run it and observe the expected failure, add minimal implementation, rerun green, then refactor.
- The existing repository baseline is not clean: `npm run typecheck` has pre-existing failures and `npm run lint` reports 120 errors/78 warnings. Every task must run focused lint/tests for touched files and must not add a new full-suite diagnostic.
- Commit each task with one or more focused conventional commits using one-shot Git identity `Codex <codex@openai.com>`; do not change global Git configuration.

---

### Task 1: Test Harness and Canonical Rank Service

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `vitest.config.ts`
- Create: `src/test/setup.ts`
- Create: `src/features/kanban/rank/rank-service.ts`
- Create: `src/features/kanban/rank/rank-service.test.ts`

**Interfaces:**
- Consumes: no earlier task.
- Produces: `RankService`, `createBase36RankService()`, `parseRank()`, and `formatRank()` for Tasks 3 and 4.

- [ ] **Step 1: Install the exact runtime and test dependencies**

Run:

```powershell
npm install --save-exact @dnd-kit/react@0.5.0 @dnd-kit/dom@0.5.0 @dnd-kit/helpers@0.5.0 @dnd-kit/abstract@0.5.0 @dnd-kit/collision@0.5.0
npm install --save-dev --save-exact vitest@4.1.10 jsdom@30.0.0 @testing-library/react@16.3.2 @testing-library/user-event@14.6.1 @testing-library/jest-dom@7.0.0 jest-axe@11.0.0 @axe-core/playwright@4.12.1
```

Add scripts:

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:unit": "vitest run src/features",
  "test:integration": "vitest run tests/integration"
}
```

- [ ] **Step 2: Configure Vitest**

Create:

```ts
// vitest.config.ts
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    environmentMatchGlobs: [["**/*.component.test.tsx", "jsdom"]],
    setupFiles: ["src/test/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    coverage: { reporter: ["text", "json-summary"] },
  },
});
```

```ts
// src/test/setup.ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 3: Write failing rank behavior tests**

The tests must use literal expected strings and cover:

```ts
import { describe, expect, it } from "vitest";
import { createBase36RankService, formatRank } from "./rank-service";

describe("base36 rank service", () => {
  const ranks = createBase36RankService();

  it("creates a rank strictly between adjacent ranks", () => {
    const previous = "0|0000000000000000000A";
    const next = "0|0000000000000000000C";
    expect(ranks.between(previous, next)).toBe("0|0000000000000000000B");
  });

  it("returns null when no integer gap remains", () => {
    expect(
      ranks.between(
        "0|0000000000000000000A",
        "0|0000000000000000000B",
      ),
    ).toBeNull();
  });

  it("rebalances tasks into deterministic ascending ranks", () => {
    const result = ranks.rebalance(["a", "b", "c"]);
    expect([...result.keys()]).toEqual(["a", "b", "c"]);
    expect([...result.values()]).toEqual(
      [...result.values()].toSorted(),
    );
    expect(new Set(result.values()).size).toBe(3);
  });

  it("rejects malformed or non-canonical ranks", () => {
    expect(() => ranks.between("a0", null)).toThrow("Invalid task rank");
    expect(() => ranks.between("0|0000000000000000000a", null))
      .toThrow("Invalid task rank");
  });

  it("formats the fixed lower boundary without losing width", () => {
    expect(formatRank(0n)).toBe("0|00000000000000000000");
  });
});
```

- [ ] **Step 4: Run the rank test and verify RED**

Run:

```powershell
npx vitest run src/features/kanban/rank/rank-service.test.ts
```

Expected: FAIL because `rank-service.ts` does not exist.

- [ ] **Step 5: Implement the minimal rank service**

Use these exact public types and constants:

```ts
export interface RankService {
  between(previous: string | null, next: string | null): string | null;
  rebalance(taskIdsInOrder: readonly string[]): ReadonlyMap<string, string>;
}

export const RANK_BUCKET = "0";
export const RANK_WIDTH = 20;
export const RANK_BASE = 36n;
export const RANK_MAX = RANK_BASE ** BigInt(RANK_WIDTH) - 1n;

export function formatRank(value: bigint): string;
export function parseRank(rank: string): bigint;
export function createBase36RankService(): RankService;
```

Validate with `/^0\|[0-9A-Z]{20}$/`. Use integer midpoint arithmetic. Rebalance with `step = RANK_MAX / BigInt(taskCount + 1)` and assign `step * BigInt(index + 1)`.

- [ ] **Step 6: Run focused tests and lint GREEN**

Run:

```powershell
npx vitest run src/features/kanban/rank/rank-service.test.ts
npx eslint vitest.config.ts src/test/setup.ts src/features/kanban/rank
```

Expected: tests pass; focused lint has zero errors.

- [ ] **Step 7: Commit Task 1**

```powershell
git add package.json package-lock.json vitest.config.ts src/test/setup.ts src/features/kanban/rank
git -c user.name="Codex" -c user.email="codex@openai.com" commit -m "test: add kanban domain harness and rank service"
```

---

### Task 2: Normalized Board State, Pure Movement Planner, and Command Queue

**Files:**
- Create: `src/features/kanban/model/types.ts`
- Create: `src/features/kanban/model/normalize-board.ts`
- Create: `src/features/kanban/model/plan-move.ts`
- Create: `src/features/kanban/model/plan-move.test.ts`
- Create: `src/features/kanban/model/task-move-queue.ts`
- Create: `src/features/kanban/model/task-move-queue.test.ts`

**Interfaces:**
- Consumes: existing `TaskType`/column shapes from `Board.tsx`, copied into focused serializable domain types.
- Produces: `KanbanBoardState`, `MoveTaskCommandDraft`, `normalizeBoard()`, `planMove()`, and `TaskMoveQueue` for Tasks 5 and 6.

- [ ] **Step 1: Write failing planner tests**

Use hand-authored fixtures and verify the exact task IDs and neighbors:

```ts
const state = {
  columnOrder: ["todo", "doing", "done"],
  taskIdsByColumn: {
    todo: ["a", "b", "c"],
    doing: ["d"],
    done: [],
  },
  tasksById: {
    a: { id: "a", columnId: "todo", version: 2 },
    b: { id: "b", columnId: "todo", version: 0 },
    c: { id: "c", columnId: "todo", version: 0 },
    d: { id: "d", columnId: "doing", version: 1 },
  },
};
```

Required cases:

```ts
it("moves c before a and derives null/a neighbors", () => {
  const result = planMove(state, {
    taskId: "c",
    toColumnId: "todo",
    targetIndex: 0,
  });
  expect(result.nextState.taskIdsByColumn.todo).toEqual(["c", "a", "b"]);
  expect(result.command).toEqual({
    toColumnId: "todo",
    beforeTaskId: null,
    afterTaskId: "a",
  });
});

it("moves b into an empty column", () => {
  const result = planMove(state, {
    taskId: "b",
    toColumnId: "done",
    targetIndex: 99,
  });
  expect(result.nextState.taskIdsByColumn.todo).toEqual(["a", "c"]);
  expect(result.nextState.taskIdsByColumn.done).toEqual(["b"]);
  expect(result.nextState.tasksById.b.columnId).toBe("done");
  expect(result.command).toEqual({
    toColumnId: "done",
    beforeTaskId: null,
    afterTaskId: null,
  });
});

it("does not mutate the source snapshot", () => {
  const frozen = structuredClone(state);
  planMove(state, { taskId: "a", toColumnId: "doing", targetIndex: 1 });
  expect(state).toEqual(frozen);
});
```

Also cover: target index below zero, target index above length, missing task, missing destination column, no-op location, and removing the active task before neighbor calculation.

- [ ] **Step 2: Run planner test and verify RED**

```powershell
npx vitest run src/features/kanban/model/plan-move.test.ts
```

Expected: FAIL because the model files do not exist.

- [ ] **Step 3: Implement normalized types and planner**

Use:

```ts
export interface KanbanTaskRecord {
  id: string;
  columnId: string;
  version: number;
  [key: string]: unknown;
}

export interface KanbanBoardState {
  columnOrder: string[];
  taskIdsByColumn: Record<string, string[]>;
  tasksById: Record<string, KanbanTaskRecord>;
}

export interface MoveTaskCommandDraft {
  toColumnId: string;
  beforeTaskId: string | null;
  afterTaskId: string | null;
}

export function planMove(
  state: KanbanBoardState,
  input: { taskId: string; toColumnId: string; targetIndex: number },
): { nextState: KanbanBoardState; command: MoveTaskCommandDraft };
```

Reject invalid IDs with a typed `KanbanMovePlanningError` carrying `TASK_NOT_FOUND` or `COLUMN_NOT_FOUND`.

- [ ] **Step 4: Run planner test GREEN**

```powershell
npx vitest run src/features/kanban/model/plan-move.test.ts
```

- [ ] **Step 5: Write failing per-task serialization tests**

The production change caught is overlapping commands for one task:

```ts
it("runs commands for the same task serially", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const queue = new TaskMoveQueue();

  const first = queue.enqueue("task-a", async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = queue.enqueue("task-a", async () => {
    events.push("second:start");
  });

  await Promise.resolve();
  expect(events).toEqual(["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  expect(events).toEqual(["first:start", "first:end", "second:start"]);
});

it("allows different tasks to run concurrently", async () => {
  const queue = new TaskMoveQueue();
  const events: string[] = [];
  await Promise.all([
    queue.enqueue("a", async () => { events.push("a"); }),
    queue.enqueue("b", async () => { events.push("b"); }),
  ]);
  expect(new Set(events)).toEqual(new Set(["a", "b"]));
});
```

- [ ] **Step 6: Run queue test RED, implement, and rerun GREEN**

Run RED:

```powershell
npx vitest run src/features/kanban/model/task-move-queue.test.ts
```

Implement:

```ts
export class TaskMoveQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  enqueue<T>(taskId: string, operation: () => Promise<T>): Promise<T>;
}
```

Use `previous.catch(() => undefined).then(operation)` and remove only the current tail in `finally`.

Run GREEN:

```powershell
npx vitest run src/features/kanban/model
npx eslint src/features/kanban/model
```

- [ ] **Step 7: Commit Task 2**

```powershell
git add src/features/kanban/model
git -c user.name="Codex" -c user.email="codex@openai.com" commit -m "feat: add deterministic kanban movement model"
```

---

### Task 3: Additive Workflow, Version, Rank, and Idempotency Schema

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260728000100_add_dnd_v2_foundation/migration.sql`
- Create: `src/features/kanban/server/move-contract.ts`
- Create: `src/features/kanban/server/move-contract.test.ts`
- Modify: `src/app/api/projects/[id]/columns/route.ts`
- Modify: `src/app/api/projects/[id]/columns/[columnId]/route.ts`
- Modify: `src/app/api/projects/route.ts`
- Modify: `src/app/api/tasks/route.ts`
- Modify: `src/app/api/tasks/[id]/route.ts`
- Modify: `src/app/api/recurring-tasks/process/route.ts`
- Modify: `src/app/api/templates/[id]/use/route.ts`
- Modify: `prisma/seed-columns.ts`
- Modify: `scripts/optimize_tasks.ts`
- Modify: `scripts/optimize_tasks_part2.ts`
- Create: `src/features/kanban/server/append-task-rank.ts`
- Create: `src/features/kanban/server/append-task-rank.test.ts`

**Interfaces:**
- Consumes: rank format from Task 1.
- Produces: Prisma fields/models and `MoveTaskRequestSchema`, `MoveTaskRequest`, `MoveTaskResponse`, and stable workflow helpers for Task 4.

- [ ] **Step 1: Write failing request-contract tests**

Required tests:

```ts
const valid = {
  toColumnId: "cmmvsjc2b000uv09wieuhci5d",
  beforeTaskId: null,
  afterTaskId: "cmmuwxh220003v09lbyd19i80",
  operationId: "b1e62929-6741-4860-a6a3-5f90b82d5a11",
  expectedVersion: 4,
};

it("accepts the exact move command", () => {
  expect(MoveTaskRequestSchema.parse(valid)).toEqual(valid);
});

it.each([
  [{ ...valid, operationId: "not-a-uuid" }, "operationId"],
  [{ ...valid, expectedVersion: -1 }, "expectedVersion"],
  [{ ...valid, toColumnId: "" }, "toColumnId"],
  [{ ...valid, extra: true }, "Unrecognized key"],
])("rejects malformed command %o", (input, message) => {
  expect(() => MoveTaskRequestSchema.parse(input)).toThrow(message);
});
```

- [ ] **Step 2: Run contract test RED**

```powershell
npx vitest run src/features/kanban/server/move-contract.test.ts
```

Expected: FAIL because the contract does not exist.

- [ ] **Step 3: Implement strict Zod contract**

```ts
export const MoveTaskRequestSchema = z.object({
  toColumnId: z.string().min(1),
  beforeTaskId: z.string().min(1).nullable(),
  afterTaskId: z.string().min(1).nullable(),
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().min(0),
}).strict();

export type MoveTaskRequest = z.infer<typeof MoveTaskRequestSchema>;

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

- [ ] **Step 4: Extend Prisma schema additively**

Add:

```prisma
model Project {
  // existing fields
  boardRevision Int     @default(0)
  dndV2Enabled  Boolean @default(false)
  moveOperations TaskMoveOperation[]
}

model ProjectColumn {
  // existing fields
  workflowKey String
  @@unique([projectId, workflowKey])
}

model Task {
  // existing fields
  version Int    @default(0)
  rank    String @db.VarChar(22)
  columnId String
  column   ProjectColumn @relation(fields: [columnId], references: [id], onDelete: Restrict)
  moveOperations TaskMoveOperation[]
  @@unique([projectId, columnId, rank])
}

model TaskMoveOperation {
  id            String   @id @default(cuid())
  operationId   String   @unique
  taskId        String
  projectId     String
  requestHash   String
  response      Json
  createdAt     DateTime @default(now())
  task          Task     @relation(fields: [taskId], references: [id], onDelete: Cascade)
  project       Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  @@index([projectId, createdAt])
}
```

The migration SQL must:

1. Add fields as nullable/defaulted.
2. Create the four default columns for any legacy project that has no columns, without changing projects that already have columns.
3. Backfill `workflowKey` once by existing column order, using the four legacy keys then `COLUMN_<id>`.
4. Backfill every null `Task.columnId` to a column in the same project by matching legacy status to `workflowKey`, with that project's first column as the deterministic fallback.
5. Backfill `rank` in `(projectId, columnId, position, id)` order using evenly spaced 20-character base-36 cores generated in SQL or a deterministic migration block.
6. Apply `COLLATE "C"` to `Task.rank`.
7. Set `workflowKey`, `Task.columnId`, and `rank` `NOT NULL`, and replace the task-column foreign key with `ON DELETE RESTRICT`.
8. Add the unique constraints and operation table.

- [ ] **Step 5: Make legacy create/update derive status from the column**

Create stable helpers in `move-contract.ts`:

```ts
export function defaultWorkflowKey(position: number, columnId: string): string;
export function derivedTaskStatus(workflowKey: string): string;
```

Default mapping is exactly `TODO`, `IN_PROGRESS`, `REVIEW`, `DONE`; later positions use `COLUMN_<columnId>`.

Update task POST/PATCH so:

- task creation validates the column belongs to the project;
- status is derived from the selected column;
- a standalone `status` update without `columnId` returns `422 STATUS_REQUIRES_COLUMN`;
- new columns receive one immutable workflow key;
- column rename/reorder does not modify `workflowKey`;
- deletion of a non-empty column returns `409 COLUMN_NOT_EMPTY`, so the canonical non-null `columnId` cannot be orphaned.

- [ ] **Step 6: Write RED tests and implement append-rank allocation for every task creator**

Use a focused port:

```ts
export interface AppendTaskRankPort {
  getLastRank(columnId: string): Promise<string | null>;
  rebalanceColumn(columnId: string): Promise<readonly string[]>;
}

export async function allocateAppendRank(input: {
  columnId: string;
  port: AppendTaskRankPort;
  ranks: RankService;
}): Promise<string>;
```

Tests prove:

- an empty column receives `between(null, null)`;
- a non-empty column receives `between(last, null)`;
- exhausted upper space causes one rebalance and a recalculation;
- the helper rejects a missing/blank column ID.

Run RED before creating the helper:

```powershell
npx vitest run src/features/kanban/server/append-task-rank.test.ts
```

Then use the helper in the normal task route, recurring processor, template use route, both optimization scripts, and seed code. Wrap rank allocation and task creation in one transaction in request/processor code. Add `workflowKey` to project default-column creation and `seed-columns.ts`.

- [ ] **Step 7: Generate Prisma and run focused verification**

```powershell
npx prisma format
npx prisma validate
npx prisma generate
npx vitest run src/features/kanban/server/move-contract.test.ts src/features/kanban/server/append-task-rank.test.ts
npx eslint src/features/kanban/server/move-contract.ts src/features/kanban/server/move-contract.test.ts src/features/kanban/server/append-task-rank.ts src/features/kanban/server/append-task-rank.test.ts "src/app/api/projects/[id]/columns/route.ts" "src/app/api/projects/[id]/columns/[columnId]/route.ts" "src/app/api/projects/route.ts" "src/app/api/tasks/route.ts" "src/app/api/tasks/[id]/route.ts" "src/app/api/recurring-tasks/process/route.ts" "src/app/api/templates/[id]/use/route.ts" prisma/seed-columns.ts scripts/optimize_tasks.ts scripts/optimize_tasks_part2.ts
```

[Строка с реквизитами или сведениями об учётных записях исключена из внешней копии; см. LOCAL_SETUP.md.]

- [ ] **Step 8: Commit Task 3**

```powershell
git add prisma src/features/kanban/server/move-contract.ts src/features/kanban/server/move-contract.test.ts src/features/kanban/server/append-task-rank.ts src/features/kanban/server/append-task-rank.test.ts "src/app/api/projects/[id]/columns/route.ts" "src/app/api/projects/[id]/columns/[columnId]/route.ts" "src/app/api/projects/route.ts" "src/app/api/tasks/route.ts" "src/app/api/tasks/[id]/route.ts" "src/app/api/recurring-tasks/process/route.ts" "src/app/api/templates/[id]/use/route.ts" scripts/optimize_tasks.ts scripts/optimize_tasks_part2.ts
git -c user.name="Codex" -c user.email="codex@openai.com" commit -m "feat: add versioned kanban ordering schema"
```

---

### Task 4: Transactional and Idempotent Move Service

**Files:**
- Create: `src/features/kanban/server/move-errors.ts`
- Create: `src/features/kanban/server/move-task-service.ts`
- Create: `src/features/kanban/server/move-task-service.test.ts`
- Create: `src/features/kanban/server/prisma-move-repository.ts`
- Create: `src/app/api/tasks/[id]/move/route.ts`
- Modify: `src/lib/activity-logger.ts`
- Modify: `src/socket/board-events.ts`
- Create: `tests/integration/task-move.integration.test.ts`

**Interfaces:**
- Consumes: `RankService`, move contract, and Prisma schema from Tasks 1 and 3.
- Produces: `moveTask()`, `PrismaMoveRepository`, API route, and versioned realtime event for Task 5.

- [ ] **Step 1: Write failing service tests around an in-memory transaction port**

Define the real service boundary:

```ts
export interface MoveTaskRepository {
  transact<T>(operation: (tx: MoveTaskTransaction) => Promise<T>): Promise<T>;
}

export interface MoveTaskTransaction {
  getOperation(operationId: string): Promise<StoredMoveOperation | null>;
  getTaskForUpdate(taskId: string): Promise<MovableTask | null>;
  getColumnForUpdate(columnId: string): Promise<MovableColumn | null>;
  getOrderedColumnTasksForUpdate(columnId: string): Promise<MovableTask[]>;
  writeRanksAndCompatibilityPositions(
    updates: readonly OrderedTaskUpdate[],
  ): Promise<void>;
  updateMovedTask(input: UpdateMovedTaskInput): Promise<MovableTask>;
  incrementBoardRevision(projectId: string): Promise<number>;
  storeOperation(input: StoreMoveOperationInput): Promise<void>;
  writeMoveActivity(input: MoveActivityInput): Promise<void>;
}
```

Required behavior tests:

- same-column exact order;
- cross-column exact order;
- empty destination;
- source task removed before neighbor validation;
- destination column from another project;
- non-adjacent/missing neighbor pair;
- stale task version;
- identical operation retry returns stored response without another write;
- operation ID reuse with different request hash;
- rank-gap exhaustion triggers one rebalance;
- injected transaction failure leaves the in-memory committed snapshot unchanged;
- board and task versions increment once.

One representative literal assertion:

```ts
expect(result).toEqual({
  operationId: "b1e62929-6741-4860-a6a3-5f90b82d5a11",
  boardRevision: 8,
  task: {
    id: "task-c",
    columnId: "doing",
    version: 3,
    status: "IN_PROGRESS",
  },
});
expect(repository.snapshot.taskIdsByColumn.doing).toEqual([
  "task-d",
  "task-c",
]);
```

- [ ] **Step 2: Run service tests RED**

```powershell
npx vitest run src/features/kanban/server/move-task-service.test.ts
```

Expected: FAIL because the service and errors do not exist.

- [ ] **Step 3: Implement typed errors and service**

Use error codes:

```ts
export type MoveTaskErrorCode =
  | "TASK_NOT_FOUND"
  | "INVALID_DESTINATION_COLUMN"
  | "INVALID_MOVE_NEIGHBORS"
  | "STALE_TASK_VERSION"
  | "OPERATION_ID_REUSED";
```

`moveTask()` accepts:

```ts
export async function moveTask(input: {
  taskId: string;
  request: MoveTaskRequest;
  repository: MoveTaskRepository;
  ranks: RankService;
}): Promise<MoveTaskResponse>;
```

Hash the canonical JSON array:

```ts
[
  taskId,
  toColumnId,
  beforeTaskId,
  afterTaskId,
  expectedVersion,
]
```

with SHA-256. Build the final ordered destination array from validated neighbors, calculate/rebalance rank, derive compatibility positions for both affected columns, increment versions, store activity and response.

- [ ] **Step 4: Run service tests GREEN**

```powershell
npx vitest run src/features/kanban/server/move-task-service.test.ts
npx eslint src/features/kanban/server/move-errors.ts src/features/kanban/server/move-task-service.ts src/features/kanban/server/move-task-service.test.ts
```

- [ ] **Step 5: Write the Prisma adapter and route**

The adapter uses:

```ts
prisma.$transaction(callback, {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,
  timeout: 15_000,
});
```

Retry serialization and unique-rank conflicts at most three times with the same operation ID. Use parameterized `$queryRaw` for `FOR UPDATE`; never concatenate identifiers or values.

The route:

1. authenticates with `getServerSession(authOptions)`;
2. parses the strict request;
3. loads the task's project ID;
4. calls `requireProjectWrite`;
5. calls the service;
6. maps typed errors to `404`, `409`, or `422`;
7. emits `task:moved` after commit with `operationId`, `version`, and `boardRevision`.

- [ ] **Step 6: Make activity logging transaction-aware**

Add:

```ts
export type ActivityWriter = Pick<
  Prisma.TransactionClient,
  "activityLog"
>;

export async function logActivityWithClient(
  client: ActivityWriter,
  params: LogActivityParams,
): Promise<void>;
```

The existing `logActivity()` delegates to the new helper with global Prisma. The move repository calls the helper with its transaction client.

- [ ] **Step 7: Add isolated PostgreSQL integration coverage**

The integration file starts with:

```ts
[Строка с реквизитами или сведениями об учётных записях исключена из внешней копии; см. LOCAL_SETUP.md.]
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
```

It must refuse URLs whose hostname matches the production host or whose database name lacks `_test`. It creates a unique project and tasks, runs the real Prisma adapter, verifies exact rank/position/version results, and deletes only rows bearing its generated test-run ID.

Cover:

- real same/cross-column transaction;
- identical idempotent retry;
- two concurrent commands into one gap;
- forced stale version;
- rollback after a test-only transaction exception.

[Строка с реквизитами или сведениями об учётных записях исключена из внешней копии; см. LOCAL_SETUP.md.]

- [ ] **Step 8: Verify Task 4**

```powershell
npx vitest run src/features/kanban/server
npx eslint src/features/kanban/server "src/app/api/tasks/[id]/move/route.ts" src/lib/activity-logger.ts src/socket/board-events.ts tests/integration/task-move.integration.test.ts
npx prisma validate
```

[Строка с реквизитами или сведениями об учётных записях исключена из внешней копии; см. LOCAL_SETUP.md.]

```powershell
npm run test:integration
```

- [ ] **Step 9: Commit Task 4**

```powershell
git add src/features/kanban/server "src/app/api/tasks/[id]/move/route.ts" src/lib/activity-logger.ts src/socket/board-events.ts tests/integration
git -c user.name="Codex" -c user.email="codex@openai.com" commit -m "feat: add transactional task movement command"
```

---

### Task 5: Modern dnd-kit Board Adapter and Exact Optimistic Rollback

**Files:**
- Create: `src/features/kanban/dnd/use-kanban-dnd.ts`
- Create: `src/features/kanban/dnd/use-kanban-dnd.test.tsx`
- Create: `src/features/kanban/dnd/SortableKanbanCard.tsx`
- Create: `src/features/kanban/dnd/KanbanCardOverlay.tsx`
- Modify: `src/components/kanban/Board.tsx`
- Modify: `src/components/kanban/Card.tsx`
- Modify: `src/components/kanban/Column.tsx`
- Modify: `src/hooks/useProjectBoard.ts`
- Modify: `src/app/(dashboard)/projects/[id]/board/ProjectBoardClient.tsx`
- Modify: `src/types/project.ts`

**Interfaces:**
- Consumes: `planMove`, `TaskMoveQueue`, and `POST /api/tasks/:id/move`.
- Produces: task-board DnD behavior and presentation components for Task 6.

- [ ] **Step 1: Extract a presentation-only card**

Refactor `Card.tsx` so:

```ts
export interface KanbanCardViewProps {
  task: TaskType;
  isDragging?: boolean;
  isPending?: boolean;
  dragHandleProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  onOpen?: () => void;
}

export function KanbanCardView(props: KanbanCardViewProps): React.ReactElement;
```

`KanbanCardView` never imports or calls any dnd-kit hook. `SortableKanbanCard` is the only task sortable registration. `KanbanCardOverlay` renders only `KanbanCardView`.

- [ ] **Step 2: Write failing component tests for one registration and rollback**

Tests must prove:

- overlay markup contains no sortable registration attribute;
- `Escape` restores the exact `KanbanBoardState` snapshot;
- canceled/outside drag sends zero network commands;
- successful drag submits exactly one semantic neighbor command;
- a rejected request restores the snapshot;
- query updates received during drag are deferred.

Use a real test component around `useKanbanDnd`, not assertions on mocked dnd-kit elements.

Representative assertion:

```ts
expect(moveClient.requests).toEqual([{
  taskId: "c",
  request: {
    toColumnId: "doing",
    beforeTaskId: "d",
    afterTaskId: null,
    operationId: expect.any(String),
    expectedVersion: 2,
  },
}]);
```

- [ ] **Step 3: Run DnD component tests RED**

```powershell
npx vitest run src/features/kanban/dnd/use-kanban-dnd.test.tsx
```

Expected: FAIL because the hook/components do not exist.

- [ ] **Step 4: Implement the new adapter**

Use:

```tsx
<DragDropProvider
  onDragStart={handlers.onDragStart}
  onDragEnd={handlers.onDragEnd}
>
  {columns}
</DragDropProvider>
```

`useSortable` receives `id`, `index`, `group`, `type: "task"`, and `accept: "task"`. Columns are lower-priority droppable targets so empty columns remain reachable. Use the source sortable `initialIndex`, `index`, `initialGroup`, and `group` values rather than comparing source/target IDs.

Mouse uses a distance constraint. Touch uses a delay/tolerance constraint from `@dnd-kit/dom`. Interactive child controls do not activate drag.

- [ ] **Step 5: Replace Board's legacy movement code**

Remove from `Board.tsx`:

- client midpoint/rebalance;
- two-second moved-task socket suppression;
- legacy `onDragOver` column mutation;
- duplicate sortable overlay;
- rank/position PATCH calls.

Render from one normalized local board state. Sync query/socket data only when no drag or queued optimistic command is active. Ignore socket task snapshots with a lower `task.version` or `boardRevision`.

Extend `Project` with `dndV2Enabled` and pass it from `ProjectBoardClient` to `KanbanBoard`. When false, render the unchanged legacy adapter. When true, use the new provider and movement endpoint. No environment variable silently enables the new protocol.

Disable drag handles when:

```ts
const reorderEnabled =
  sortBy === "position" &&
  statusFilter === "ALL" &&
  priorityFilter === "ALL";
```

If other filters exist, include each in this predicate.

- [ ] **Step 6: Run tests and focused lint GREEN**

```powershell
npx vitest run src/features/kanban/model src/features/kanban/dnd
npx eslint src/features/kanban/dnd src/components/kanban/Board.tsx src/components/kanban/Card.tsx src/components/kanban/Column.tsx src/hooks/useProjectBoard.ts "src/app/(dashboard)/projects/[id]/board/ProjectBoardClient.tsx" src/types/project.ts
```

Run `npm run typecheck` and compare output to the recorded baseline. Any new diagnostic in a touched file blocks completion even though unrelated baseline diagnostics remain.

- [ ] **Step 7: Commit Task 5**

```powershell
git add src/features/kanban/dnd src/components/kanban/Board.tsx src/components/kanban/Card.tsx src/components/kanban/Column.tsx src/hooks/useProjectBoard.ts "src/app/(dashboard)/projects/[id]/board/ProjectBoardClient.tsx" src/types/project.ts
git -c user.name="Codex" -c user.email="codex@openai.com" commit -m "feat: migrate task board to modern dnd-kit"
```

---

### Task 6: Accessible Move Menu, Russian Announcements, Theme, and Reduced Motion

**Files:**
- Create: `src/features/kanban/accessibility/move-announcements.ts`
- Create: `src/features/kanban/accessibility/move-announcements.test.ts`
- Create: `src/features/kanban/components/TaskMoveMenu.tsx`
- Create: `src/features/kanban/components/TaskMoveMenu.component.test.tsx`
- Modify: `src/components/kanban/Card.tsx`
- Modify: `src/components/kanban/Board.tsx`
- Modify: `src/app/globals.css`
- Modify: `src/providers/theme-provider.tsx`
- Modify: `src/components/shared/theme-toggle.tsx`
- Create: `src/features/kanban/theme/theme-contract.component.test.tsx`

**Interfaces:**
- Consumes: `planMove` and the same move client from Task 5.
- Produces: WCAG dragging alternative, focus recovery, correct theme tokens, and reduced-motion behavior.

- [ ] **Step 1: Write failing announcement tests**

Use exact Russian results:

```ts
expect(announceMove({
  title: "Исправить авторизацию",
  fromColumn: "К выполнению",
  toColumn: "В работе",
  position: 2,
  total: 5,
})).toBe(
  "Задача «Исправить авторизацию» перемещена из «К выполнению» " +
  "в «В работе», позиция 2 из 5.",
);

expect(announceCancel("Исправить авторизацию")).toBe(
  "Перемещение задачи «Исправить авторизацию» отменено.",
);
```

Also assert no output contains a supplied internal task ID.

- [ ] **Step 2: Run announcement tests RED, implement, rerun GREEN**

```powershell
npx vitest run src/features/kanban/accessibility/move-announcements.test.ts
```

Implement pure functions and rerun the same command.

- [ ] **Step 3: Write failing move-menu component tests**

Cover:

- accessible trigger name includes task title;
- every destination column appears;
- `В начало`, `Выше`, `Ниже`, `В конец` enablement matches position;
- selecting a destination submits one semantic command through the same client;
- focus returns to the trigger when the task remains visible;
- filtered-out move focuses the board heading and announces the result;
- axe reports no serious/critical violations for the menu state.

- [ ] **Step 4: Run move-menu tests RED**

```powershell
npx vitest run src/features/kanban/components/TaskMoveMenu.component.test.tsx
```

- [ ] **Step 5: Implement the menu and focus lifecycle**

Use the card's existing action menu if present; do not add a second competing ellipsis button. The trigger has:

```tsx
aria-label={`Действия задачи «${task.title}»`}
```

All menu outcomes call `planMove` and the Task 5 move coordinator. No menu code calls task PATCH or edits status directly.

- [ ] **Step 6: Write failing theme-contract tests**

The behavior tests render a priority card inside `.dark` and assert computed semantic classes/attributes rather than grepping CSS source. Also render ThemeToggle and assert:

```ts
expect(screen.getByRole("button", { name: "Выбрать тему" }))
  .toBeInTheDocument();
```

Create one browser-level contrast assertion in Task 7; jsdom cannot prove real computed contrast.

- [ ] **Step 7: Repair theme and motion**

At the top of `globals.css` add:

```css
@custom-variant dark (&:where(.dark, .dark *));
```

Define complete `:root` and `.dark` semantic variables:

```css
--background;
--foreground;
--card;
--card-foreground;
--muted;
--muted-foreground;
--primary;
--primary-foreground;
--border;
--input;
--ring;
```

Close `.btn-ghost--accent:hover` before subsequent rules. Replace invalid forms such as `var(--border/60)` with `color-mix(in oklab, var(--border) 60%, transparent)`.

Add:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Configure the Motion provider with `reducedMotion="user"`. Give the theme button the name `Выбрать тему`.

- [ ] **Step 8: Run Task 6 verification**

```powershell
npx vitest run src/features/kanban/accessibility src/features/kanban/components src/features/kanban/theme
npx eslint src/features/kanban/accessibility src/features/kanban/components src/features/kanban/theme src/components/kanban/Card.tsx src/components/kanban/Board.tsx src/providers/theme-provider.tsx src/components/shared/theme-toggle.tsx
npm run build
```

The build must no longer emit warnings caused by malformed Kanban/theme CSS. Unrelated documented baseline warnings must be listed rather than hidden.

- [ ] **Step 9: Commit Task 6**

```powershell
git add src/features/kanban/accessibility src/features/kanban/components src/features/kanban/theme src/components/kanban/Card.tsx src/components/kanban/Board.tsx src/app/globals.css src/providers/theme-provider.tsx src/components/shared/theme-toggle.tsx
git -c user.name="Codex" -c user.email="codex@openai.com" commit -m "feat: make kanban movement accessible and theme-safe"
```

---

### Task 7: Isolated Browser Regression Suite and Final Verification

**Files:**
- Modify: `playwright.config.ts`
- Create: `e2e/fixtures/isolated-project.cjs`
- Create: `e2e/kanban-dnd-v2.spec.cjs`
- Create: `e2e/kanban-theme-accessibility.spec.cjs`
- Create: `docs/TESTING_KANBAN_DND_V2.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed board, movement endpoint, and theme behavior.
- Produces: reproducible end-to-end coverage and operator documentation.

- [ ] **Step 1: Make production an invalid automated-test default**

Change Playwright configuration so `baseURL` is:

```ts
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3555";
if (/kanban\.lenremontn8n\.ru/i.test(baseURL)) {
  throw new Error("Automated Playwright tests cannot target production");
}
```

Add Chromium, Firefox, WebKit, Pixel 7, and iPhone 13 projects. Local web-server startup is enabled only when `PLAYWRIGHT_EXTERNAL_SERVER !== "1"`.

- [ ] **Step 2: Write isolated API fixture**

The fixture:

[Строка с реквизитами или сведениями об учётных записях исключена из внешней копии; см. LOCAL_SETUP.md.]
- generates a unique run ID;
- creates one user, project, four columns, and deterministic tasks through test-only setup code or authenticated API;
- enables `dndV2Enabled`;
- returns IDs/titles to the test;
- removes only entities with that run ID in `finally`.

[Строка с реквизитами или сведениями об учётных записях исключена из внешней копии; см. LOCAL_SETUP.md.]

- [ ] **Step 3: Write failing exact-order browser tests**

Cover:

```js
test("same-column order persists after reload", async ({ page, project }) => {
  await project.openBoard(page);
  await project.dragTask(page, "Task C", {
    column: "К выполнению",
    before: "Task A",
  });
  await page.reload();
  await expect(project.taskTitles(page, "К выполнению"))
    .resolves.toEqual(["Task C", "Task A", "Task B"]);
});
```

Also test:

- cross-column move and return;
- empty-column drop;
- `Escape` and outside-drop restoration;
- click/tap move menu;
- keyboard focus and Russian live region;
- drag disabled under filters/non-position sort;
- forced `409` conflict rollback;
- network failure rollback and retry;
- no unexpected console error or failed move request.

- [ ] **Step 4: Write theme/accessibility browser tests**

Cover light, dark, and system screenshots at desktop/mobile/tablet sizes. Use `page.emulateMedia({ reducedMotion: "reduce" })`.

Calculate contrast from computed `color` and `backgroundColor` for each priority card; require at least `4.5:1` for normal text and `3:1` for large text/non-text drag indicators.

Run axe and fail on serious/critical findings in the board, move menu, and task-detail-open states.

- [ ] **Step 5: Prove the regression tests fail against the legacy feature-flag state**

Against a local server with an isolated database:

```powershell
$env:PLAYWRIGHT_BASE_URL="http://127.0.0.1:3555"
[Строка с реквизитами или сведениями об учётных записях исключена из внешней копии; см. LOCAL_SETUP.md.]
npx playwright test e2e/kanban-dnd-v2.spec.cjs e2e/kanban-theme-accessibility.spec.cjs --project=chromium
```

Run the new suite once with `dndV2Enabled=false` for the isolated fixture. The exact-order, keyboard, and dark-theme regression cases must fail for their named legacy behaviors. Then set the isolated fixture's flag to `true` and run the same tests GREEN. This mutation check proves that the browser tests detect the production defects rather than merely exercising a happy path.

- [ ] **Step 6: Run the full verification matrix**

```powershell
npm test
npx prisma validate
npm run build
npx eslint src/features/kanban src/components/kanban src/components/shared/theme-toggle.tsx src/providers/theme-provider.tsx "src/app/api/tasks/[id]/move/route.ts"
npx playwright test e2e/kanban-dnd-v2.spec.cjs e2e/kanban-theme-accessibility.spec.cjs
```

Run `npm run typecheck` and `npm run lint` once more. Report the full baseline debt and prove no new diagnostic is attributable to this branch; do not call those two commands “passing” until the separate cleanup sub-project reaches zero.

Use the in-app Browser for final visual/manual checks on:

- pointer drag and return;
- same-column reload persistence;
- keyboard/menu alternative;
- light/dark/system;
- 390×844 mobile;
- console/network health.

- [ ] **Step 7: Document verified and unverified coverage**

`docs/TESTING_KANBAN_DND_V2.md` must include:

- exact commands and required environment variables;
- database safety guards;
- browser/device matrix;
- automated results;
- manual screen-reader checks still required;
- any suite not run and the concrete blocker;
- rollback procedure using `Project.dndV2Enabled`.

- [ ] **Step 8: Commit Task 7**

```powershell
git add playwright.config.ts e2e/fixtures/isolated-project.cjs e2e/kanban-dnd-v2.spec.cjs e2e/kanban-theme-accessibility.spec.cjs docs/TESTING_KANBAN_DND_V2.md README.md
git -c user.name="Codex" -c user.email="codex@openai.com" commit -m "test: verify reliable kanban movement end to end"
```

---

## Final Branch Gate

After all seven tasks:

1. Generate a whole-branch review package from `ee2a0cd34062cdaf52176ce77ff8eb74fff98fb7` to `HEAD`.
2. Dispatch the most capable reviewer for spec compliance, concurrency, security, accessibility, and regression risk.
3. Send all Critical/Important findings to one fix agent, then perform one scoped re-review.
4. Re-run every available verification command after fixes.
5. Use the in-app Browser for final reversible production comparison only; do not enable `dndV2Enabled` or deploy without a separate deployment request.
6. Finish with `superpowers:finishing-a-development-branch` and present branch/PR options.

