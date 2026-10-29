/**
 * Versioned product analytics catalog for issue #54.
 *
 * This module is the single source of truth for what may be collected. Values
 * are closed machine labels: never task text, chat text, search strings, form
 * values, URLs or query parameters. A caller cannot add a name at runtime.
 *
 * `TELEMETRY_CATALOG_VERSION` is the contract version. It moves together with
 * `schemaVersion` (currently 1); a consumer must reject an unknown version.
 */
export const TELEMETRY_CATALOG_VERSION = 1;

/** Screens/cards a user can open. `task.detail` is the task card itself. */
export const TELEMETRY_SCREENS = [
  "home",
  "board",
  "task.detail",
  "my-tasks",
  "inbox",
  "messages",
  "analytics",
  "settings",
  "admin",
  "admin.telemetry",
  "login",
  "register",
] as const;
export type TelemetryScreen = (typeof TELEMETRY_SCREENS)[number];

/** Existing project view modes (`ViewSwitcher`). */
export const TELEMETRY_VIEWS = ["board", "table", "calendar"] as const;
export type TelemetryView = (typeof TELEMETRY_VIEWS)[number];

/**
 * Filter facets from `FilterBar`. Only the facet name is recorded; the selected
 * value is user data and never leaves the browser.
 */
export const TELEMETRY_FILTERS = ["status", "priority", "assignee", "tags", "sort"] as const;
export type TelemetryFilter = (typeof TELEMETRY_FILTERS)[number];

/**
 * Every UI action the contract accepts. The first four have no HTTP command of
 * their own and are recorded as intent only; the rest can be paired with a
 * `client.request.result`.
 */
export const TELEMETRY_UI_ACTIONS = [
  "screen.view",
  "board.view.change",
  "board.filter.change",
  "board.search",
  "task.create",
  "task.update",
  "task.move",
  "comment.create",
  "attachment.upload",
  "task.checklist.toggle",
] as const;
export type TelemetryUiAction = (typeof TELEMETRY_UI_ACTIONS)[number];

/** Closed event names, split by producer. */
export const TELEMETRY_CLIENT_EVENTS = [
  "ui.action",
  "client.request.result",
  "client.render.failed",
  "client.breadcrumb",
  "client.problem.reported",
] as const;
export const TELEMETRY_SERVER_EVENTS = [
  "api.request.completed",
  "api.request.failed",
  "task.checklist.updated",
] as const;
export type TelemetryClientEventName = (typeof TELEMETRY_CLIENT_EVENTS)[number];
export type TelemetryServerEventName = (typeof TELEMETRY_SERVER_EVENTS)[number];
export type TelemetryEventName = TelemetryClientEventName | TelemetryServerEventName;

/** A producer cannot promote an event to a different purpose by choosing a category. */
export const TELEMETRY_EVENT_CATEGORY: Readonly<Record<TelemetryEventName, "usage" | "diagnostic">> = {
  "ui.action": "usage",
  "client.request.result": "diagnostic",
  "client.render.failed": "diagnostic",
  "client.breadcrumb": "diagnostic",
  "client.problem.reported": "diagnostic",
  "api.request.completed": "diagnostic",
  "api.request.failed": "diagnostic",
  "task.checklist.updated": "usage",
};

/**
 * Explicit route templates for actions that issue an HTTP command. Routes are
 * assigned here by the owner, never derived from a URL. Client-only actions
 * (screen/view/filter/search) have no server route.
 */
export const TELEMETRY_ACTION_ROUTES: Readonly<Partial<Record<TelemetryUiAction, string>>> = {
  "board.search": "/api/tasks",
  "task.create": "/api/tasks",
  "task.update": "/api/tasks/:id",
  "task.move": "/api/tasks/:id/move",
  "comment.create": "/api/tasks/:id/messages",
  "attachment.upload": "/api/tasks/:id/attachments",
  "task.checklist.toggle": "/api/tasks/:id/checklist/:itemId",
};

/** Routes are assigned by their owners, never inferred from a URL or query.
 * Only routes whose handler is actually wrapped in `withApiLogging` belong here;
 * a declared-but-unwrapped route would claim a server event nobody writes.
 * `/api/tasks/:id/attachments` is absent on purpose: that handler only has PATCH
 * for metadata, and real uploads go through /api/uploads/direct and
 * presign/finalize, so attachment success is reported by the client action. */
export const TELEMETRY_SERVER_ROUTES = new Set([
  // details GET and command PATCH/POST already use withApiLogging.
  "/api/tasks/:id",
  "/api/tasks/:id/checklist/:itemId",
  "/api/tasks/:id/messages",
  "/api/recurring-tasks",
  "/api/recurring-tasks/:id",
]);

const UI_ACTION_SET = new Set<string>(TELEMETRY_UI_ACTIONS);
const SCREEN_SET = new Set<string>(TELEMETRY_SCREENS);
const VIEW_SET = new Set<string>(TELEMETRY_VIEWS);
const FILTER_SET = new Set<string>(TELEMETRY_FILTERS);

export function isTelemetryUiAction(value: unknown): value is TelemetryUiAction {
  return typeof value === "string" && UI_ACTION_SET.has(value);
}

export function isTelemetryScreen(value: unknown): value is TelemetryScreen {
  return typeof value === "string" && SCREEN_SET.has(value);
}

export function isTelemetryView(value: unknown): value is TelemetryView {
  return typeof value === "string" && VIEW_SET.has(value);
}

export function isTelemetryFilter(value: unknown): value is TelemetryFilter {
  return typeof value === "string" && FILTER_SET.has(value);
}
