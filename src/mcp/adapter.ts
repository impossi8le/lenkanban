import { z } from "zod";
import { hashApiToken, parseApiToken } from "@/lib/api-tokens";
import { McpError } from "./errors";
import type { Arguments, ToolName } from "./schemas";

export type Actor = Readonly<{ id: string; globalRole: "USER" | "ADMIN" }>;
export type CorrelationContext = Readonly<{ requestId: string; actionId?: string }>;
export type CallContext = Readonly<{ actor: Actor; authorization: string; requestId: string; actionId?: string }>;
export interface CanonicalPort {
  authenticate(authorization: string, context?: CorrelationContext): Promise<Actor>;
  projectAccess(actor: Actor, projectId: string, context?: CallContext): Promise<{ canRead: boolean }>;
  request(path: string, context: CallContext, body?: unknown): Promise<unknown>;
}
export function bearer(headers: Headers): string {
  const value = headers.get("authorization");
  if (!value || !/^Bearer [^\s]+$/i.test(value) || !parseApiToken(value.slice(7))) throw new McpError("UNAUTHENTICATED");
  return `Bearer ${value.slice(7)}`;
}
export function tokenKey(authorization: string): string { return hashApiToken(authorization.slice(7)); }

// The canonical reader response is untrusted at this boundary. Only known DTO fields survive.
const row = z.object({}).passthrough();
type Row = z.infer<typeof row>;
function canonicalValue<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new McpError("DEPENDENCY_UNAVAILABLE");
  return parsed.data;
}
const records = (value: unknown) => canonicalValue(z.array(row), value);
const record = (value: unknown) => canonicalValue(row, value);
const segment = (value: string) => encodeURIComponent(value);

/**
 * Bounded discovery. Boards are now read through the shared `/api/projects`
 * cursor reader (`limit`/`cursor`, `id asc`), so MCP never materializes the whole
 * inventory to paginate it. Resource discovery still has a hard ceiling: a
 * truncated `resources/list` would claim a complete inventory, so overflow is an
 * explicit PAGINATION_LIMIT instead.
 */
export const discoveryLimits = { resources: 500, page: 100 } as const;
const boardRow = z.object({ id: z.string().min(1).max(128), name: z.string(),
  description: z.string().nullable(), updatedAt: z.string().datetime({ offset: true }),
  _count: z.object({ tasks: z.number().int().nonnegative() }).passthrough() }).passthrough();
const boardPage = z.object({ items: z.array(boardRow), nextCursor: z.string().min(1).max(128).nullable(),
  hasMore: z.boolean() }).passthrough();
export type BoardSummary = Readonly<{ id: string; name: string; description: string | null;
  updatedAt: string; taskCount: number; memberCount: number | null }>;
export type ResourceSummary = Readonly<{ uri: string; name: string; mimeType: string }>;
const taskSummary = (task: Row) => ({ ...task, assigneeIds: Array.isArray(task.assignees)
  ? records(task.assignees).map(assignee => assignee.userId) : [] });

export class CanonicalAdapter {
  constructor(readonly port: CanonicalPort) {}

  async readTask(taskId: string, context: CallContext): Promise<Row> {
    const task = record(await this.port.request(`/api/tasks/${segment(taskId)}?view=details`, context));
    canonicalValue(z.string().min(1).max(128), task.projectId);
    return task;
  }
  async readBoard(projectId: string, context: CallContext): Promise<void> {
    if (!(await this.port.projectAccess(context.actor, projectId, context)).canRead) throw new McpError("NOT_FOUND");
  }
  /**
   * Stable board inventory from the shared `/api/projects` cursor reader.
   * The reader orders by `id asc`, returns the exact `limit + 1` sentinel and
   * applies the same access filter as the legacy unbounded response.
   */
  async listBoards(input: { query?: string; limit: number; after?: string }, context: CallContext) {
    const query = new URLSearchParams({ limit: String(input.limit) });
    if (input.query) query.set("search", input.query);
    if (input.after !== undefined) query.set("cursor", input.after);
    const page = canonicalValue(boardPage, await this.port.request(`/api/projects?${query}`, context));
    if (page.items.length > input.limit) throw new McpError("DEPENDENCY_UNAVAILABLE");
    // Reject a reader that duplicates, reorders or skips: a cursor page must be
    // strictly increasing and the sentinel must point at its last row.
    for (let index = 0; index < page.items.length; index++) {
      if (index > 0 && page.items[index - 1].id >= page.items[index].id) {
        throw new McpError("DEPENDENCY_UNAVAILABLE");
      }
    }
    if (page.hasMore !== (page.nextCursor !== null)
      || (page.hasMore && page.nextCursor !== page.items[page.items.length - 1]?.id)) {
      throw new McpError("DEPENDENCY_UNAVAILABLE");
    }
    const items: BoardSummary[] = page.items.map(value => {
      const board = canonicalValue(boardRow, value);
      return { id: board.id, name: board.name, description: board.description,
        updatedAt: board.updatedAt, taskCount: board._count.tasks, memberCount: null };
    });
    return { items, hasMore: page.hasMore, nextCursor: page.nextCursor };
  }
  /**
   * Discovery beyond boards: task resources inside the boards the actor already
   * sees. Task ids come from the shared tasks reader, which applies
   * `getTaskReadWhere` and the board preflight; no new grant is introduced.
   * `_count.tasks` from the same board projection proves completeness: if the
   * reader yields a different number of unique ids, discovery fails instead of
   * publishing a partial list.
   */
  async listResources(context: CallContext): Promise<ResourceSummary[]> {
    const resources: ResourceSummary[] = [];
    const boards: BoardSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listBoards({ limit: discoveryLimits.page,
        ...(cursor === undefined ? {} : { after: cursor }) }, context);
      boards.push(...page.items);
      if (boards.length > discoveryLimits.resources) throw new McpError("PAGINATION_LIMIT");
      cursor = page.hasMore ? page.nextCursor ?? undefined : undefined;
    } while (cursor !== undefined);

    for (const board of boards) {
      // Board resource plus the board's exact readable task count must fit.
      if (resources.length + 1 + board.taskCount > discoveryLimits.resources) {
        throw new McpError("PAGINATION_LIMIT");
      }
      resources.push({ uri: `kanban://board/${board.id}`, name: board.name, mimeType: "application/json" });
      const seen = new Set<string>();
      for (let page = 1; board.taskCount > 0; page++) {
        if (page > 1000) throw new McpError("PAGINATION_LIMIT");
        const tasks = await this.readTasks({ projectId: board.id, page, limit: discoveryLimits.page }, context);
        for (const task of tasks.items) {
          const id = canonicalValue(z.string().min(1).max(128), task.id);
          if (seen.has(id)) continue;
          seen.add(id);
          const title = canonicalValue(z.string(), task.title);
          resources.push({ uri: `kanban://task/${id}`, name: title, mimeType: "application/json" });
        }
        if (!tasks.hasMore) break;
      }
      if (seen.size !== board.taskCount) throw new McpError("PAGINATION_LIMIT");
    }
    return resources;
  }
  /** Preserve the reader's offset and sentinel; changing limit changes skip. */
  async readTasks(input: Arguments["list_tasks"], context: CallContext):
    Promise<{ items: Row[]; page: number; limit: number; hasMore: boolean }> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) query.set(key, String(value));
    const result = canonicalValue(z.object({ items: z.array(row),
      page: z.number().int().positive(), limit: z.number().int().min(1).max(100), hasMore: z.boolean(),
    }), await this.port.request(`/api/tasks?${query}`, context));
    const page = input.search ? 1 : input.page;
    const limit = input.search ? 10 : input.limit;
    if (result.page !== page || result.limit !== limit || result.items.length > limit
      || (result.hasMore && result.items.length !== limit)) throw new McpError("DEPENDENCY_UNAVAILABLE");
    return { ...result, items: result.items.map(taskSummary) };
  }
  async run(name: ToolName, args: Arguments[ToolName], context: CallContext): Promise<unknown> {
    if (name === "list_boards") {
      const input = args as Arguments["list_boards"];
      return this.listBoards({ query: input.query, limit: input.limit,
        ...(input.cursor ? { after: input.cursor } : {}) }, context);
    }
    if (name === "get_board") {
      const { projectId } = args as Arguments["get_board"];
      await this.readBoard(projectId, context);
      const board = record(await this.port.request(`/api/projects/${segment(projectId)}`, context));
      const counts = record(board._count);
      const columns = await this.port.request(`/api/projects/${segment(projectId)}/columns`, context);
      return { board: { ...board, taskCount: counts.tasks, memberCount: counts.members }, columns };
    }
    if (name === "list_tasks") {
      const input = args as Arguments["list_tasks"];
      await this.readBoard(input.projectId, context);
      return this.readTasks(input, context);
    }
    if (name === "create_task") {
      const input = args as Arguments["create_task"];
      await this.readBoard(input.projectId, context);
      return this.port.request("/api/tasks", context, input);
    }
    const taskId = (args as { taskId: string }).taskId;
    const task = await this.readTask(taskId, context);
    if (name === "get_task") return { ...task,
      assignees: records(task.assignees).map(assignee => ({ id: assignee.id, userId: record(assignee.user).id,
        name: record(assignee.user).name, avatarUrl: record(assignee.user).avatarUrl })),
      tags: records(task.tags).map(tag => record(tag.tag)) };
    if (name === "get_task_history") {
      let items: Row[];
      try { items = records(await this.port.request(`/api/activities?taskId=${segment(taskId)}`, context)); }
      catch (error) {
        // The legacy history route uses 403 for missing membership. Keep the
        // same hidden-resource response even if access changes after preflight.
        if (error instanceof McpError && error.code === "FORBIDDEN") throw new McpError("NOT_FOUND");
        throw error;
      }
      return { items, limit: 50, truncated: items.length === 50 };
    }
    if (name === "list_task_messages") {
      const input = args as Arguments["list_task_messages"];
      const query = new URLSearchParams({ limit: String(input.limit) });
      if (input.cursor) query.set("cursor", input.cursor);
      return this.port.request(`/api/tasks/${segment(taskId)}/messages?${query}`, context);
    }
    if (name === "update_task") {
      const input = args as Arguments["update_task"];
      const body = { operationId: input.operationId, expectedVersion: input.expectedVersion, changes: input.changes };
      return this.port.request(`/api/tasks/${segment(taskId)}`, context, body);
    }
    if (name === "add_task_comment") {
      const { taskId: _taskId, ...body } = args as Arguments["add_task_comment"];
      return this.port.request(`/api/tasks/${segment(_taskId)}/messages`, context, body);
    }
    if (name === "move_task") {
      const { taskId: _taskId, ...body } = args as Arguments["move_task"];
      return this.port.request(`/api/tasks/${segment(_taskId)}/move`, context, body);
    }
    throw new McpError("INVALID_ARGUMENT");
  }
}

