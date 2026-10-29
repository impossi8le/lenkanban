import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRoomSubscriptions, type RoomActor } from "./room-subscriptions";
import { getProjectAccess } from "@/lib/project-access";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const rooms = new Set<string>();
  const authenticate = vi.fn(async (): Promise<RoomActor | null> => ({ userId: "actor", globalRole: "USER" }));
  const project = { findUnique: vi.fn(async () => ({ ownerId: "other", members: [{ role: "MEMBER" }] })) };
  const canReadProject = vi.fn(async (actor: RoomActor, id: string) =>
    (await getProjectAccess({ id: actor.userId, globalRole: actor.globalRole }, id, { project } as unknown as Parameters<typeof getProjectAccess>[2])).canRead,
  );
  const taskProject = vi.fn(async (): Promise<string | null> => "project");
  const join = vi.fn(async (room: string) => { rooms.add(room); });
  const leave = vi.fn(async (room: string) => { rooms.delete(room); });
  const subscriptions = createRoomSubscriptions({ expectedUserId: "actor", authenticate, canReadProject, taskProject, join, leave });
  return { subscriptions, authenticate, project, canReadProject, taskProject, join, leave, rooms };
}
let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });

describe("fresh per-socket room admissions", () => {
  it('uses task policy instead of project membership for task rooms and rechecks on admission', async () => {
    const canReadTask = vi.fn(async () => false);
    const join = vi.fn();
    const leave = vi.fn();
    const subscriptions = createRoomSubscriptions({
      expectedUserId: 'actor', authenticate: f.authenticate, canReadProject: f.canReadProject,
      taskProject: f.taskProject, canReadTask, join, leave,
    });
    const denied = vi.fn();
    await subscriptions.joinTask({ taskId: 'hidden' }, denied);
    expect(denied).toHaveBeenCalledExactlyOnceWith({ ok: false, error: 'AccessDenied' });
    expect(join).not.toHaveBeenCalled();
    expect(f.canReadProject).not.toHaveBeenCalled();
    canReadTask.mockResolvedValueOnce(true);
    await subscriptions.joinTask({ taskId: 'visible' });
    expect(join).toHaveBeenCalledExactlyOnceWith('task:visible');
    const revoked = vi.fn();
    await subscriptions.joinTask({ taskId: 'visible' }, revoked);
    expect(revoked).toHaveBeenCalledExactlyOnceWith({ ok: false, error: 'AccessDenied' });
    expect(leave).toHaveBeenCalledWith('task:visible');
    expect(canReadTask).toHaveBeenCalledTimes(3);
  });
  it.each(["project", "task"] as const)("uses common fresh ADMIN policy for a nonmember %s", async kind => {
    f.project.findUnique.mockResolvedValue({ ownerId: "other", members: [] });
    f.authenticate.mockResolvedValue({ userId: "actor", globalRole: "ADMIN" });
    const ack = vi.fn();
    await (kind === "project" ? f.subscriptions.joinProject({ projectId: "project" }, ack) : f.subscriptions.joinTask({ taskId: "task" }, ack));
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
    expect(f.join).toHaveBeenCalledWith(`${kind}:${kind}`);
    expect(f.canReadProject).toHaveBeenCalledWith({ userId: "actor", globalRole: "ADMIN" }, "project");
  });
  it("refreshes role on every admission and denies a revoked nonmember", async () => {
    f.project.findUnique.mockResolvedValue({ ownerId: "other", members: [] });
    f.authenticate.mockResolvedValueOnce({ userId: "actor", globalRole: "ADMIN" }).mockResolvedValueOnce({ userId: "actor", globalRole: "USER" });
    await f.subscriptions.joinProject({ projectId: "one" });
    const ack = vi.fn();
    await f.subscriptions.joinProject({ projectId: "two" }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "AccessDenied" });
    expect(f.rooms).toEqual(new Set(["project:one"]));
    expect(f.authenticate).toHaveBeenCalledTimes(2);
  });
  it.each([null, { userId: "other", globalRole: "ADMIN" }] as const)("denies notification admission for invalid fresh identity %#", async actor => {
    f.authenticate.mockResolvedValue(actor);
    const ack = vi.fn(); await f.subscriptions.joinNotifications(ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "Unauthorized" });
    expect(f.join).not.toHaveBeenCalled();
  });
  it("joins only the authenticated user's notification room and awaits join before ACK", async () => {
    const gate = deferred<void>();
    f.join.mockImplementation(async room => { await gate.promise; f.rooms.add(room); });
    const ack = vi.fn(); const pending = f.subscriptions.joinNotifications(ack);
    await vi.waitFor(() => expect(f.join).toHaveBeenCalledWith("user:actor"));
    expect(ack).not.toHaveBeenCalled();
    gate.resolve(); await pending;
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });
  it.each([undefined, null, [], {}, { projectId: 4 }, { projectId: "user:other" }, { projectId: "x".repeat(129) }])("rejects malformed project payload %# without auth or rejection", async payload => {
    const ack = vi.fn(); await expect(f.subscriptions.joinProject(payload, ack)).resolves.toBeUndefined();
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "InvalidRoomPayload" });
    expect(f.authenticate).not.toHaveBeenCalled();
  });
  it("hides missing tasks and stops before project policy", async () => {
    f.taskProject.mockResolvedValue(null); const ack = vi.fn();
    await f.subscriptions.joinTask({ taskId: "missing" }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "AccessDenied" });
    expect(f.canReadProject).not.toHaveBeenCalled();
  });
  it("cancels slow auth after leave without joining or successful ACK", async () => {
    const gate = deferred<RoomActor | null>(); f.authenticate.mockReturnValueOnce(gate.promise);
    const ack = vi.fn(); const pending = f.subscriptions.joinProject({ projectId: "project" }, ack);
    await f.subscriptions.leaveProject({ projectId: "project" });
    gate.resolve({ userId: "actor", globalRole: "USER" }); await pending;
    expect(f.join).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "SubscriptionCancelled" });
  });
  it("cleans a stale adapter join before a newer join so compensation cannot remove the new room", async () => {
    const gate = deferred<void>();
    f.join.mockImplementationOnce(async room => { await gate.promise; f.rooms.add(room); });
    const oldAck = vi.fn(), newAck = vi.fn();
    const old = f.subscriptions.joinProject({ projectId: "project" }, oldAck);
    await vi.waitFor(() => expect(f.join).toHaveBeenCalledOnce());
    const leave = f.subscriptions.leaveProject({ projectId: "project" });
    const newer = f.subscriptions.joinProject({ projectId: "project" }, newAck);
    gate.resolve(); await Promise.all([old, leave, newer]);
    expect(f.rooms).toEqual(new Set(["project:project"]));
    expect(oldAck).toHaveBeenCalledWith({ ok: false, error: "SubscriptionCancelled" });
    expect(newAck).toHaveBeenCalledExactlyOnceWith({ ok: true });
    expect(f.leave.mock.invocationCallOrder.at(-1)).toBeLessThan(f.join.mock.invocationCallOrder.at(-1)!);
  });
  it.each(["auth", "join"] as const)("disconnect prevents pending %s from resurrecting membership", async stage => {
    const gate = deferred<void>();
    if (stage === "auth") f.authenticate.mockImplementationOnce(async () => { await gate.promise; return { userId: "actor", globalRole: "USER" }; });
    else f.join.mockImplementationOnce(async room => { await gate.promise; f.rooms.add(room); });
    const ack = vi.fn(); const pending = f.subscriptions.joinTask({ taskId: "task" }, ack);
    if (stage === "join") await vi.waitFor(() => expect(f.join).toHaveBeenCalledOnce());
    f.subscriptions.disconnect(); gate.resolve(); await pending;
    expect(f.rooms.size).toBe(0);
    expect(ack).not.toHaveBeenCalledWith({ ok: true });
  });
  it("contains thrown auth, transport and ACK failures without sensitive errors", async () => {
    f.authenticate.mockRejectedValueOnce(new Error("synthetic-private-cookie")); const ack = vi.fn();
    await expect(f.subscriptions.joinNotifications(ack)).resolves.toBeUndefined();
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "RoomJoinFailed" });
    f.join.mockRejectedValueOnce(new Error("synthetic-private-adapter"));
    await expect(f.subscriptions.joinNotifications(() => { throw Error("ack"); })).resolves.toBeUndefined();
    await expect(f.subscriptions.leaveProject(null)).resolves.toBeUndefined();
    await expect(f.subscriptions.joinNotifications({ userId: "forged" })).resolves.toBeUndefined();
  });
  it("removes a previous project membership before acknowledging a denied re-admission", async () => {
    await f.subscriptions.joinProject({ projectId: "project" });
    expect(f.rooms.has("project:project")).toBe(true);
    f.project.findUnique.mockResolvedValue({ ownerId: "other", members: [] });
    let membershipAtAck: boolean | undefined;
    const ack = vi.fn(() => { membershipAtAck = f.rooms.has("project:project"); });
    await f.subscriptions.joinProject({ projectId: "project" }, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "AccessDenied" });
    expect(membershipAtAck).toBe(false);
    expect(f.leave).toHaveBeenCalledWith("project:project");
  });
  it("does not let an older denied auth attempt remove a newer authorized membership", async () => {
    const gate = deferred<RoomActor | null>();
    f.authenticate.mockReturnValueOnce(gate.promise);
    const oldAck = vi.fn(), currentAck = vi.fn();
    const old = f.subscriptions.joinProject({ projectId: "project" }, oldAck);
    await f.subscriptions.joinProject({ projectId: "project" }, currentAck);
    expect(currentAck).toHaveBeenCalledExactlyOnceWith({ ok: true });
    gate.resolve(null); await old;
    expect(oldAck).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "SubscriptionCancelled" });
    expect(f.rooms).toEqual(new Set(["project:project"]));
    expect(f.leave).not.toHaveBeenCalled();
  });
});
