import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const mocks = vi.hoisted(() => ({ actorId: "one", status: "authenticated", fetch: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: mocks.actorId } }, status: mocks.status }) }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.fetch }));
import { useRequestQueueUnseenCounts } from "./useRequestQueueUnseenCounts";
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
beforeEach(() => { mocks.actorId = "one"; mocks.status = "authenticated"; mocks.fetch.mockReset(); client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); });
afterEach(() => { cleanup(); client.clear(); });
it("shares one actor-scoped count request and uses the existing abortable API", async () => {
  mocks.fetch.mockResolvedValue({ byProject: { board: 2 }, total: 2 });
  const first = renderHook(useRequestQueueUnseenCounts, { wrapper });
  const second = renderHook(useRequestQueueUnseenCounts, { wrapper });
  await waitFor(() => expect(first.result.current.total).toBe(2));
  expect(second.result.current.byProject).toEqual({ board: 2 });
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith("/api/tasks/queue-unseen", { signal: expect.any(AbortSignal) });
});
it("does not show a previous actor's count while the new actor request is pending", async () => {
  mocks.fetch.mockResolvedValueOnce({ byProject: { board: 5 }, total: 5 });
  const view = renderHook(useRequestQueueUnseenCounts, { wrapper });
  await waitFor(() => expect(view.result.current.total).toBe(5));
  mocks.fetch.mockImplementation(() => new Promise(() => {})); mocks.actorId = "two";
  view.rerender();
  expect(view.result.current.total).toBe(0); expect(view.result.current.byProject).toEqual({});
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
});
it.each(["loading", "unauthenticated"])("does not fetch or expose cached counts while session is %s", status => {
  mocks.status = status;
  client.setQueryData(["request-queue-unseen", "one"], { byProject: { board: 8 }, total: 8 });
  const { result } = renderHook(useRequestQueueUnseenCounts, { wrapper });
  expect(result.current.total).toBe(0); expect(mocks.fetch).not.toHaveBeenCalled();
});
it.each([
  null, [], { byProject: [], total: 0 }, { byProject: { board: -1 }, total: -1 },
  { byProject: { board: "1" }, total: 1 }, { byProject: { board: 1 }, total: 2 },
  { byProject: { board: 1.1 }, total: 1.1 }, { byProject: {}, total: Number.MAX_SAFE_INTEGER + 1 },
])("rejects malformed counts instead of presenting a successful empty response (%j)", async response => {
  mocks.fetch.mockResolvedValue(response);
  const { result } = renderHook(useRequestQueueUnseenCounts, { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.byProject).toEqual({}); expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
it("does not retain stale counts as success when a fresh ACL read fails", async () => {
  mocks.fetch.mockResolvedValueOnce({ byProject: { board: 3 }, total: 3 });
  const { result } = renderHook(useRequestQueueUnseenCounts, { wrapper });
  await waitFor(() => expect(result.current.total).toBe(3));
  mocks.fetch.mockRejectedValue(new Error("unavailable"));
  await result.current.refetch();
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.total).toBe(0); expect(result.current.byProject).toEqual({});
});
