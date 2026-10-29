# Validation security boundary

Local security integration, 2026-10-24; this document does not claim deployment.

Use the patched Zod4 API (exact4.6.7), not zod/v3 compatibility imports. Upper array/set/map bounds must reject oversized input before walking elements. This does not impose a universal cap on unconstrained collections or replace HTTP body-size controls.

Approved product decision: PATCH /api/tasks/bulk and POST /api/tasks/bulk-update accept at most200 taskIds per request, enough for the104-task acceptance board. Count every supplied element before deduplication. Oversized collections return the existing422 VALIDATION_ERROR with one taskIds bound issue before quota consumption, task queries, mutation transactions or effects. Collections within200 retain normal element validation, authentication, actor quota and existing task/project/transactional ACL checks. POST still authenticates the session before reading the body; PATCH retains its existing validation-before-auth order.

Keep API validation status422 and field-path/message response shape; never include raw submitted values. MCP schemas must advertise their actual runtime constraints, including defaults/optionality, custom status regex and unknown-record values. Zod4's required unknown properties must be explicitly optional where canonical error envelopes omit data. Other collections and production perimeter settings require their own evidence, not an audit-zero claim.

Attachments PATCH authenticates before reading/parsing untrusted JSON and reuses the existing MAX_TASK_ATTACHMENTS=100 quota from append.ts for the replacement metadata array. Oversized arrays reject before element validation or business queries. This introduces no new quota value: stored file service fields, canonical reference preservation, task locks, mutation policy and effects remain mandatory. Authenticated malformed JSON still returns400; ordinary valid metadata within100 retains the existing actor-scoped read/write checks.
