import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "./notification-bell";

const controls = vi.hoisted(() => ({ connected: true, api: vi.fn() }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "actor-a" } }, status: "authenticated" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/useNotificationSocket", () => ({
  useNotificationSocket: () => ({ socket: null, connected: controls.connected }),
}));
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => controls.api(...args) }));

const clients: QueryClient[] = [];

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const tree = () => (
    <QueryClientProvider client={client}>
      <NotificationBell />
    </QueryClientProvider>
  );
  const view = render(tree());
  return () => view.rerender(tree());
}

function unreadCountRequests() {
  return controls.api.mock.calls.filter(([url]) => String(url).endsWith("unread-count"));
}

beforeEach(() => {
  vi.useFakeTimers();
  controls.connected = true;
  controls.api.mockReset().mockImplementation(async (url: string) =>
    url.endsWith("unread-count") ? { actorId: "actor-a", count: 1, byProject: {}, byTask: {}, unscopedCount: 1 } : []);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.useRealTimers();
});

describe("notification badge fallback polling", () => {
  it("shows the exact shared event total above nine instead of a different visible cap", async () => {
    controls.api.mockImplementation(async (url: string) => url.endsWith("unread-count") ? { actorId: "actor-a", count: 13, byProject: { bank: 12, support: 1 }, byTask: {}, unscopedCount: 0 } : []);
    mount(); await flush();
    expect(screen.getByLabelText("Непрочитанных уведомлений: 13")).toHaveTextContent("13");
    expect(screen.queryByText("9+")).not.toBeInTheDocument();
  });
  it("refreshes on the first personal-room join, including notifications committed before that join", async () => {
    controls.connected = false;
    const rerender = mount(); await flush();
    expect(unreadCountRequests()).toHaveLength(1);
    controls.api.mockImplementation(async (url: string) => url.endsWith("unread-count") ? { actorId: "actor-a", count: 2, byProject: {}, byTask: {}, unscopedCount: 2 } : []);
    controls.connected = true;
    await act(async () => rerender()); await flush();
    expect(unreadCountRequests()).toHaveLength(2);
    expect(screen.getByText("2")).toBeVisible();
  });

  it("reconciles a suspended tab once and coalesces repeated focus/visibility events", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    mount(); await flush();
    controls.api.mockImplementation(async (url: string) => url.endsWith("unread-count") ? { actorId: "actor-a", count: 2, byProject: {}, byTask: {}, unscopedCount: 2 } : []);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(100);
    }); await flush(); await flush();
    expect(unreadCountRequests()).toHaveLength(2); expect(screen.getByText("2")).toBeVisible();
    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus"));
      }
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(unreadCountRequests()).toHaveLength(2);
  });
  it("does not poll while the notification socket is connected", async () => {
    mount();
    await flush();
    expect(unreadCountRequests()).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });

    expect(unreadCountRequests()).toHaveLength(1);
    expect(screen.getByText("1")).toBeVisible();
  });

  it("polls while the notification socket is disconnected", async () => {
    controls.connected = false;
    mount();
    await flush();
    expect(unreadCountRequests()).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(65_000); });

    expect(unreadCountRequests().length).toBeGreaterThanOrEqual(3);
  });
});
