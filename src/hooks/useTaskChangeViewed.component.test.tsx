import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { useTaskChangeViewed } from "./useTaskChangeViewed";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
let focused = true;
let client: QueryClient;
const props = { actorId: "accountant", projectId: "board", taskId: "task", snapshotToken: "snapshot-1", ready: true, unseen: true };
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
beforeEach(() => {
  vi.useFakeTimers(); focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal("cancelAnimationFrame", (timer: number) => clearTimeout(timer));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(apiFetch).mockResolvedValue({ changed: true, stale: false });
});
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it("acknowledges the shown snapshot only after two focused frames", async () => {
  renderHook(() => useTaskChangeViewed(props), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(16); });
  expect(apiFetch).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(16); });
  expect(apiFetch).toHaveBeenCalledOnce();
  const options = vi.mocked(apiFetch).mock.calls[0][1]!;
  expect(JSON.parse(String(options.body))).toEqual({ expectedActorId: "accountant", snapshotToken: "snapshot-1" });
});
it("reads a new notification even when the work snapshot was already viewed; refreshes every count bucket", async () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = renderHook((ready: boolean) => useTaskChangeViewed({ ...props, unseen: false, notificationCount: 2, ready }), { wrapper, initialProps: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(apiFetch).not.toHaveBeenCalled();
  view.rerender(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(32); });
  expect(apiFetch).toHaveBeenCalledOnce();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["notifications", "accountant"] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["task-changes", "accountant", "board"] });
});
it("does not mark a loading or background card; resumes on focus", async () => {
  focused = false;
  const view = renderHook((ready: boolean) => useTaskChangeViewed({ ...props, ready }), { wrapper, initialProps: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  view.rerender(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(apiFetch).not.toHaveBeenCalled();
  focused = true;
  await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(32); });
  expect(apiFetch).toHaveBeenCalledOnce();
});
it("cancels a scheduled view when closed, and never marks an already seen snapshot", async () => {
  const view = renderHook(() => useTaskChangeViewed(props), { wrapper });
  view.unmount();
  renderHook(() => useTaskChangeViewed({ ...props, unseen: false }), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(apiFetch).not.toHaveBeenCalled();
});
it("keeps a failed receipt visible until explicit retry succeeds", async () => {
  vi.mocked(apiFetch).mockRejectedValueOnce(new Error("network"));
  const view = renderHook(() => useTaskChangeViewed(props), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(32); });
  expect(view.result.current.status).toBe("failed");
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(apiFetch).toHaveBeenCalledOnce();
  await act(async () => { view.result.current.retry(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(32); });
  expect(view.result.current.status).toBe("seen");
});
it("aborts the old identity and acknowledges the next actor's own snapshot", async () => {
  vi.mocked(apiFetch).mockImplementationOnce(() => new Promise(() => {}));
  const view = renderHook((value: typeof props) => useTaskChangeViewed(value), { wrapper, initialProps: props });
  await act(async () => { await vi.advanceTimersByTimeAsync(32); });
  const signal = vi.mocked(apiFetch).mock.calls[0][1]!.signal!;
  view.rerender({ ...props, actorId: "sales", snapshotToken: "snapshot-2" });
  expect(signal.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(32); });
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[1][1]!.body))).toEqual({ expectedActorId: "sales", snapshotToken: "snapshot-2" });
});
