import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api";
import { useRequestQueueSeen, type RequestQueueSeenOptions } from "./useRequestQueueSeen";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
const fetchMock = vi.mocked(apiFetch);
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let focused: boolean;
let visibility: DocumentVisibilityState;
const base = (): RequestQueueSeenOptions => ({ actorId: "actor-a", taskId: "task-a", queueArrival: { epoch: 1, unseen: true }, authoritative: true, active: true });
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function paint() {
  for (let frame = 0; frame < 2; frame++) {
  await act(async () => {
    const queued = [...frames.values()]; frames.clear();
    queued.forEach(callback => callback(1));
    await Promise.resolve();
  });
  }
}
beforeEach(() => {
  frames = new Map(); nextFrame = 0; focused = true; visibility = "visible";
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ changed: true, stale: false });
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("useRequestQueueSeen", () => {
  it("records only after paint and validates the session assertion and abort signal", async () => {
    const onAcknowledged = vi.fn();
    const { result, rerender } = renderHook(props => useRequestQueueSeen(props), { initialProps: { ...base(), onAcknowledged } });
    expect(fetchMock).not.toHaveBeenCalled();
    await paint();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/tasks/task-a/queue-seen", expect.objectContaining({
      method: "POST", body: JSON.stringify({ queueEpoch: 1, expectedActorId: "actor-a" }), signal: expect.any(AbortSignal),
    }));
    expect(result.current.status).toBe("seen");
    expect(onAcknowledged).toHaveBeenCalledTimes(1);
    rerender({ ...base(), onAcknowledged });
    act(() => window.dispatchEvent(new Event("focus")));
    await paint();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    { authoritative: false }, { active: false }, { actorId: null }, { taskId: null },
    { queueArrival: null }, { queueArrival: { epoch: 0, unseen: true } },
    { queueArrival: { epoch: 1, unseen: false } },
  ])("does not acknowledge an ineligible card %j", async change => {
    renderHook(() => useRequestQueueSeen({ ...base(), ...change }));
    await paint(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("waits for focused visible paint, and rechecks focus at dispatch", async () => {
    focused = false; visibility = "hidden";
    renderHook(() => useRequestQueueSeen(base()));
    await paint(); expect(fetchMock).not.toHaveBeenCalled();
    act(() => { visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
    await paint(); expect(fetchMock).not.toHaveBeenCalled();
    act(() => { focused = true; window.dispatchEvent(new Event("focus")); });
    focused = false;
    await paint(); expect(fetchMock).not.toHaveBeenCalled();
    act(() => { focused = true; window.dispatchEvent(new Event("focus")); });
    await paint(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["actor", "task", "epoch", "inactive", "unmount"])("cancels scheduled paint on %s change", async change => {
    const { rerender, unmount } = renderHook(props => useRequestQueueSeen(props), { initialProps: base() });
    if (change === "unmount") unmount();
    else rerender({ ...base(), ...(change === "actor" ? { actorId: "actor-b" } : change === "task" ? { taskId: "task-b" } : change === "epoch" ? { queueArrival: { epoch: 2, unseen: true } } : { active: false }) });
    await paint();
    if (change === "inactive" || change === "unmount") expect(fetchMock).not.toHaveBeenCalled();
    else {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [path, init] = fetchMock.mock.calls[0];
      expect(path).toBe(change === "task" ? "/api/tasks/task-b/queue-seen" : "/api/tasks/task-a/queue-seen");
      expect(JSON.parse(init!.body as string)).toEqual({ queueEpoch: change === "epoch" ? 2 : 1, expectedActorId: change === "actor" ? "actor-b" : "actor-a" });
    }
  });
  it.each(["actor", "epoch", "unmount"])("aborts and ignores obsolete inflight completion on %s", async change => {
    const old = deferred(); fetchMock.mockReturnValueOnce(old.promise);
    const onAcknowledged = vi.fn();
    const initial = { ...base(), onAcknowledged };
    const { rerender, unmount } = renderHook(props => useRequestQueueSeen(props), { initialProps: initial });
    await paint();
    const signal = fetchMock.mock.calls[0][1]!.signal!;
    if (change === "unmount") unmount();
    else rerender({ ...initial, ...(change === "actor" ? { actorId: "actor-b" } : { queueArrival: { epoch: 2, unseen: true } }) });
    expect(signal.aborted).toBe(true);
    await act(async () => { old.resolve({ changed: true, stale: false }); });
    expect(onAcknowledged).not.toHaveBeenCalled();
  });
  it("keeps failure until explicit retry, with one inflight request", async () => {
    const pending = deferred(); fetchMock.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(props => useRequestQueueSeen(props), { initialProps: base() });
    await paint(); rerender(base());
    act(() => window.dispatchEvent(new Event("focus"))); await paint();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new Error("offline")));
    expect(result.current.status).toBe("failed");
    rerender(base()); act(() => window.dispatchEvent(new Event("focus"))); await paint();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => result.current.retry()); await paint();
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(result.current.status).toBe("seen");
  });
  it("a stale epoch asks for refresh without claiming seen or retrying that epoch", async () => {
    fetchMock.mockResolvedValueOnce({ changed: false, stale: true });
    const onAcknowledged = vi.fn(), onStale = vi.fn();
    const { result } = renderHook(() => useRequestQueueSeen({ ...base(), onAcknowledged, onStale }));
    await paint();
    expect(onAcknowledged).not.toHaveBeenCalled(); expect(onStale).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("idle");
    act(() => { result.current.retry(); window.dispatchEvent(new Event("focus")); }); await paint();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed ACK without clearing the marker", async () => {
    fetchMock.mockResolvedValueOnce({ changed: true });
    const onAcknowledged = vi.fn();
    const { result } = renderHook(() => useRequestQueueSeen({ ...base(), onAcknowledged }));
    await paint(); expect(result.current.status).toBe("failed"); expect(onAcknowledged).not.toHaveBeenCalled();
  });
  it("clears a failed retry state when a fresh server projection says the arrival is no longer unseen", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const { result, rerender } = renderHook(props => useRequestQueueSeen(props), { initialProps: base() });
    await paint(); expect(result.current.status).toBe("failed");
    rerender({ ...base(), queueArrival: { epoch: 1, unseen: false } });
    expect(result.current.status).toBe("seen");
    act(() => result.current.retry()); await paint(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
