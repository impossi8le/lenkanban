/**
 * Shared bounds for the task list endpoint (`GET /api/tasks`).
 *
 * The board is refetched on every board switch, so an unbounded response makes
 * navigation slow. 200 is enough for a typical board (several columns of a few
 * dozen cards each); 500 is the ceiling a client may request when it really
 * renders a large board. Search stays a fixed 10-row typeahead.
 */
export const TASK_LIST_DEFAULT_LIMIT = 200;
export const TASK_LIST_MAX_LIMIT = 500;
export const TASK_SEARCH_LIMIT = 10;
