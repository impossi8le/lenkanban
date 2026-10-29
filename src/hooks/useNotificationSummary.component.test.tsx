import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const controls = vi.hoisted(() => ({ actor: "sales", fetch: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: controls.actor } }, status: "authenticated" }) }));
vi.mock("@/lib/api", () => ({ apiFetch: controls.fetch }));
import { parseNotificationSummary, useNotificationSummary } from "./useNotificationSummary";
let client: QueryClient;
const summary = (count = 3) => ({ actorId: controls.actor, count, byProject: { bank: count }, byTask: { one: count }, unscopedCount: 0 });
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
beforeEach(() => { controls.actor = "sales"; controls.fetch.mockReset().mockResolvedValue(summary()); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(() => { cleanup(); client.clear(); });

it("shares one actor-owned event count between consumers and reconciles all buckets after read", async () => {
  const view = renderHook(() => ({ bell: useNotificationSummary(), sidebar: useNotificationSummary() }), { wrapper });
  await waitFor(() => expect(view.result.current.bell.count).toBe(3));
  expect(view.result.current.sidebar.byProject).toEqual({ bank: 3 });
  expect(view.result.current.sidebar.byTask).toEqual({ one: 3 });
  expect(controls.fetch).toHaveBeenCalledTimes(1);
  controls.fetch.mockResolvedValue(summary(0));
  await act(async () => { await client.invalidateQueries({ queryKey: ["notifications", "sales"] }); });
  await waitFor(() => expect(view.result.current.bell.count).toBe(0));
  expect(view.result.current.sidebar.byProject).toEqual({ bank: 0 });
});
it("never shows the old actor's summary while the next account is loading", async () => {
  const view = renderHook(() => useNotificationSummary(), { wrapper });
  await waitFor(() => expect(view.result.current.count).toBe(3));
  controls.actor = "accountant"; controls.fetch.mockImplementation(() => new Promise(() => {}));
  view.rerender();
  expect(view.result.current.count).toBeUndefined();
  expect(view.result.current.byProject).toBeUndefined();
});
it("reports a failed refresh as unknown rather than a genuine zero", async () => {
  controls.fetch.mockRejectedValue(new Error("offline"));
  const view = renderHook(() => useNotificationSummary(), { wrapper });
  await waitFor(() => expect(view.result.current.isError).toBe(true));
  expect(view.result.current.count).toBeUndefined();
  expect(view.result.current.byTask).toBeUndefined();
});
it("rejects foreign actors, inconsistent sums and invalid bucket counts", () => {
  expect(() => parseNotificationSummary({ ...summary(), actorId: "other" }, "sales")).toThrow();
  expect(() => parseNotificationSummary({ ...summary(), count: 4 }, "sales")).toThrow();
  expect(() => parseNotificationSummary({ ...summary(), byTask: { one: 9 } }, "sales")).toThrow();
  expect(() => parseNotificationSummary({ ...summary(), byProject: { bank: -1 } }, "sales")).toThrow();
});
