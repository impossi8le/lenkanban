import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const state = vi.hoisted(() => ({ joined: true, handlers: new Map<string, (value: unknown) => void>(), routerRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: state.routerRefresh }) }));
vi.mock("./useProjectBoard", () => ({ useProjectBoard: () => ({ isJoined: state.joined, socket: {
  on: (event: string, callback: (value: unknown) => void) => state.handlers.set(event, callback),
  off: (event: string) => state.handlers.delete(event),
} }) }));
import { useTaskDetailRealtime } from "./useTaskDetailRealtime";
let client: QueryClient;
beforeEach(() => { vi.useFakeTimers(); state.joined = true; state.handlers.clear(); state.routerRefresh.mockReset(); client = new QueryClient(); });
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); });
function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
it("rechecks join gaps/reconnects with a canonical callback without mutating the router", async () => {
  const read = vi.fn(); const view = renderHook(() => useTaskDetailRealtime("project", "task", read), { wrapper });
  await act(() => vi.advanceTimersByTimeAsync(100)); expect(read).toHaveBeenCalledTimes(1); expect(state.routerRefresh).not.toHaveBeenCalled();
  state.joined = false; view.rerender(); state.joined = true; view.rerender();
  await act(() => vi.advanceTimersByTimeAsync(100)); expect(read).toHaveBeenCalledTimes(2); expect(state.routerRefresh).not.toHaveBeenCalled();
});
it("coalesces matching events, ignores foreign events and cancels pending reads on close", async () => {
  state.joined = false; const read = vi.fn(); const view = renderHook(() => useTaskDetailRealtime("project", "task", read), { wrapper });
  act(() => { state.handlers.get("task:updated")?.({ id: "other", projectId: "project" }); });
  await act(() => vi.advanceTimersByTimeAsync(100)); expect(read).not.toHaveBeenCalled();
  act(() => { state.handlers.get("task:updated")?.({ id: "task", projectId: "project" }); state.handlers.get("task:moved")?.({ task: { id: "task" } }); });
  await act(() => vi.advanceTimersByTimeAsync(100)); expect(read).toHaveBeenCalledTimes(1);
  act(() => { state.handlers.get("task:deleted")?.({ taskId: "task", projectId: "project" }); });
  view.unmount(); await act(() => vi.advanceTimersByTimeAsync(100)); expect(read).toHaveBeenCalledTimes(1); expect(state.handlers.size).toBe(0); expect(state.routerRefresh).not.toHaveBeenCalled();
});
