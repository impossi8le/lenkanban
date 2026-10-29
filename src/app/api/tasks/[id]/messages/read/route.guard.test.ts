import { expect, it } from "vitest";
import { fixture, marker, boundary } from "./route-test-support";
import { POST } from "./route";
import { TASK_REQUEST_STATES } from "@/lib/task-request-policy";

it.each(TASK_REQUEST_STATES)("accepts canonical %s only after common reader revalidation", async state => {
  const f = fixture(); f.options.marker = marker(state);
  expect((await POST(f.request(), f.context)).status).toBe(200);
  expect(f.tx.task.findFirst).toHaveBeenCalledOnce();
  expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  expect(f.database.$executeRaw).not.toHaveBeenCalled();
  expect(f.trace).toEqual(["begin", "project-lock", "task-lock", "group-lock", "watcher-lock", "actor-lock", "fresh-actor", "fresh-reader", "execute", "commit"]);
});
it.each([{ ...marker(), state: "UNKNOWN" }, { ...marker(), contractVersion: 2 }, { ...marker(), taskId: "foreign" }, { ...marker(), unexpected: true }, { ...marker(), executorId: null }])("fails closed on malformed stored marker %#", async request => {
  const f = fixture(); f.options.marker = request;
  const response = await POST(f.request(), f.context);
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "INVALID_REQUEST_MARKER" });
  expect(f.tx.$executeRaw).not.toHaveBeenCalled(); expect(f.state).toEqual(f.before);
});
it("conceals deleted marked requests even with an empty batch", async () => {
  const f = fixture(); f.options.marker = { ...marker("CLOSED"), deletedAt: new Date() };
  expect((await POST(f.request({ messageIds: [] }), f.context)).status).toBe(404);
  expect(f.tx.$executeRaw).not.toHaveBeenCalled();
});
it.each(["actor", "blocked", "blockedAt", "revoked", "project", "task", "demoted"])("denies fresh %s before empty-batch success", async condition => {
  const f = fixture();
  if (condition === "actor") f.options.actor = false;
  if (condition === "blocked") f.options.isBlocked = true;
  if (condition === "blockedAt") f.options.blockedAt = new Date();
  if (condition === "revoked") f.options.readable = false;
  if (condition === "project") f.options.projectMissing = true;
  if (condition === "task") f.options.taskMissing = true;
  if (condition === "demoted") { f.options.outerRole = "ADMIN"; f.options.role = "USER"; f.options.readable = false; }
  expect((await POST(f.request({ messageIds: [] }), f.context)).status).toBe(404);
  expect(f.tx.$executeRaw).not.toHaveBeenCalled(); expect(f.state).toEqual(f.before);
});
it("rejects task identity drift after stable project lock", async () => {
  const f = fixture(); f.options.identityDrift = true;
  expect((await POST(f.request(), f.context)).status).toBe(409); expect(f.tx.$executeRaw).not.toHaveBeenCalled();
});
it("returns zero for an authenticated fresh reader empty batch without message SQL", async () => {
  const f = fixture(); f.options.marker = marker("CLOSED");
  expect(await (await POST(f.request({ messageIds: [] }), f.context)).json()).toEqual({ ok: true, markedRead: 0 });
  expect(f.tx.task.findFirst).toHaveBeenCalledOnce(); expect(f.tx.$executeRaw).not.toHaveBeenCalled();
});
it("preserves original receipt and other readers on retry", async () => {
  const f = fixture(); await POST(f.request(), f.context); const first = structuredClone(f.state);
  expect(await (await POST(f.request(), f.context)).json()).toEqual({ ok: true, markedRead: 0 }); expect(f.state).toEqual(first); expect(f.state.readBy.other).toBe("earlier");
});
it.each(["execute", "commit", "marker", "internal"])("rolls back %s failure and emits only static diagnostic fields", async failure => {
  const f = fixture();
  if (failure === "execute") f.options.executeFailure = true;
  if (failure === "commit") f.options.commitFailure = true;
  if (failure === "marker") f.options.markerFailure = true;
  if (failure === "internal") boundary.internal.mockRejectedValue(Error("synthetic-private-internal"));
  const response = await POST(f.request(), f.context); expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Failed to mark messages as read" }); expect(f.state).toEqual(f.before);
  expect(boundary.diagnostic).toHaveBeenCalledExactlyOnceWith({ event: "task.messages.read.failed", route: "/api/tasks/:id/messages/read" });
});
it.each([false, true])("keeps fixed response when diagnostic sink fails async=%s", async asynchronous => {
  const f = fixture(); f.options.executeFailure = true;
  boundary.diagnostic.mockImplementation(() => { if (asynchronous) return Promise.reject(Error("synthetic-sink")); throw Error("synthetic-sink"); });
  expect((await POST(f.request(), f.context)).status).toBe(500); expect(f.state).toEqual(f.before);
});
