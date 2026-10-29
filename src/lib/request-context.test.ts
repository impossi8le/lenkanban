import { expect, it } from "vitest";
import { createRequestLogContext } from "./request-context";
import { validCorrelationId } from "./telemetry-sanitize";
it("creates a server request ID per attempt, keeps one valid action ID and never trusts incoming request ID", () => {
  const actionId = "30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93";
  const headers = new Headers({
    "x-action-id": actionId,
    "x-request-id": actionId
  });
  const first = createRequestLogContext(headers, {
    route: "/api/tasks/:id",
    actorId: "actor-1"
  });
  const retry = createRequestLogContext(headers);
  expect(validCorrelationId(first.requestId)).toBe(true);
  expect(first.requestId).not.toBe(actionId);
  expect(retry.requestId).not.toBe(first.requestId);
  expect(first.actionId).toBe(retry.actionId);
  expect(first.route).toBe("/api/tasks/:id");
});
it("omits malformed untrusted IDs without logging their value or inventing route/actor", () => {
  const context = createRequestLogContext(new Headers({
    "x-action-id": "private".repeat(1000)
  }));
  expect(context).not.toHaveProperty("actionId");
  expect(context).not.toHaveProperty("actorId");
  expect(context).not.toHaveProperty("route");
});
it("cannot override generated IDs through extra runtime context fields", () => {
  const forged = "30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93";
  const context = createRequestLogContext(new Headers(), {
    route: "/api/tasks?token=private",
    actorId: "private@example.invalid",
    requestId: forged,
    actionId: forged
  } as {
    route: string;
    actorId: string;
  });
  expect(context.requestId).not.toBe(forged);
  expect(context).not.toHaveProperty("actionId");
  expect(context).not.toHaveProperty("actorId");
  expect(context).not.toHaveProperty("route");
});
