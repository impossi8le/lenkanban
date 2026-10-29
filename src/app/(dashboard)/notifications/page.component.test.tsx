import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NotificationsPage from "./page";
import { NotificationBell } from "@/components/layout/notification-bell";

const mocks = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn(), session: { actorId: "actor-a", status: "authenticated" } }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: mocks.session.status, data: mocks.session.actorId ? { user: { id: mocks.session.actorId } } : null }) }));
vi.mock("@/hooks/useNotificationSocket", () => ({ useNotificationSocket: () => ({ socket: null, connected: true }) }));
vi.mock("@/hooks/useBrowserNotifications", () => ({ useBrowserNotifications: () => ({}) }));

const notice = (id: string, read = false, actionUrl: string | null = null) => ({
  id, title: `Уведомление ${id}`, message: `Сообщение ${id}`, read, actionUrl,
  createdAt: "2026-10-25T09:00:00.000Z", type: "TASK_ASSIGNED", readAt: null, metadata: null,
});
let notices = [notice("new", false, "/projects/board/tasks/task"), notice("old", true)];
const clients: QueryClient[] = [];
const requestPermission = vi.fn();
class BrowserNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = requestPermission;
}
function mount(withBell = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  const view = render(<QueryClientProvider client={client}>{withBell && <NotificationBell />}<NotificationsPage /></QueryClientProvider>);
  return { client, ...view };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.actorId = "actor-a";
  mocks.session.status = "authenticated";
  notices = [notice("new", false, "/projects/board/tasks/task"), notice("old", true)];
  BrowserNotification.permission = "default";
  requestPermission.mockResolvedValue("granted");
  vi.stubGlobal("Notification", BrowserNotification);
  mocks.api.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === "/api/notifications/unread-count") return { actorId: mocks.session.actorId, count: notices.filter(n => !n.read).length, byProject: {}, byTask: {}, unscopedCount: notices.filter(n => !n.read).length };
    if (options?.method === "PATCH") {
      notices = notices.map(n => url.endsWith("mark-all-read") || url.endsWith(encodeURIComponent(n.id)) ? { ...n, read: true } : n);
      return null;
    }
    return notices;
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.unstubAllGlobals();
});

describe("actual notification center", () => {
  it("shares the actor list cache and refreshes current task state when the bell opens", async () => {
    const { client } = mount(true);
    await screen.findByRole("heading", { name: "Уведомление new" });
    fireEvent.click(screen.getByRole("button", { name: "Уведомления" }));
    const dialog = await screen.findByRole("dialog", { name: "Уведомления" });
    expect(within(dialog).getByText("Уведомление new")).toBeVisible();
    await waitFor(() => expect(mocks.api.mock.calls.filter(([url]) => url === "/api/notifications?limit=20")).toHaveLength(2));
    expect(client.getQueryCache().findAll({ queryKey: ["notifications", "actor-a", "list"], exact: true })).toHaveLength(1);
    expect(client.getQueryData(["notifications", "actor-a", "list"])).toEqual(notices);
    expect(client.getQueryData(["notifications", "actor-a", "unread-count"])).toMatchObject({ count: 1 });
  });

  it("opens the safe local task without clearing its notice before the card actually loads", async () => {
    const { client } = mount(true);
    await screen.findByRole("heading", { name: "Уведомление new" });
    fireEvent.click(screen.getByRole("button", { name: "Открыть обращение →" }));
    expect(mocks.push).toHaveBeenCalledWith("/projects/board/tasks/task");
    expect(mocks.api.mock.calls.filter(([, options]) => options?.method === "PATCH")).toHaveLength(0);
    await waitFor(() => expect(client.getQueryData(["notifications", "actor-a", "unread-count"])).toMatchObject({ count: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "Непрочитанные" }));
    expect(screen.getByRole("heading", { name: "Уведомление new" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Уведомление old" })).not.toBeInTheDocument();
  });

  it("marks all read once while pending and refetches the list", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const ordinary = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith("mark-all-read")) await pending;
      return ordinary(url, options);
    });
    mount();
    await screen.findByRole("heading", { name: "Уведомление new" });
    const button = screen.getByRole("button", { name: "Прочитать все" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(mocks.api.mock.calls.filter(([url]) => url.endsWith("mark-all-read"))).toHaveLength(1);
    await act(async () => { release(); await pending; });
    await waitFor(() => expect(mocks.api.mock.calls.filter(([url]) => url === "/api/notifications?limit=20")).toHaveLength(2));
    expect(button).toBeDisabled();
  });

  it.each(["https://example.invalid/task", "//example.invalid/task", "javascript:alert(1)", "/\\example.invalid/task"])("does not navigate to unsafe URL %s", async actionUrl => {
    notices = [notice("unsafe", true, actionUrl)];
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Открыть обращение →" }));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.api.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
  });

  it("never requests browser permission on mount; a click updates the permission state", async () => {
    mount();
    const enable = await screen.findByRole("button", { name: "Включить уведомления браузера" });
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(enable);
    await screen.findByText("Включены. Вы получите уведомление, пока сайт открыт.");
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Включить уведомления браузера" })).not.toBeInTheDocument();
  });

  it("resyncs browser permission on focus without prompting", async () => {
    mount();
    await screen.findByRole("button", { name: "Включить уведомления браузера" });
    BrowserNotification.permission = "denied";
    fireEvent(window, new Event("focus"));
    await screen.findByText("Заблокированы. Разрешите уведомления в настройках сайта в браузере.");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("does not render another actor's cached notices after a session change", async () => {
    const { rerender, client } = mount();
    await screen.findByRole("heading", { name: "Уведомление new" });
    mocks.session.actorId = "actor-b";
    mocks.api.mockReturnValue(new Promise(() => {}));
    rerender(<QueryClientProvider client={client}><NotificationsPage /></QueryClientProvider>);
    expect(screen.queryByRole("heading", { name: "Уведомление new" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Загрузка уведомлений");
    expect(client.getQueryState(["notifications", "actor-b", "list"])).toBeDefined();
  });

  it("shows failed mutations and keeps the notice available for retry", async () => {
    const ordinary = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === "PATCH") throw new Error("Synthetic failure");
      return ordinary(url, options);
    });
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Прочитать все" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Прочитать все" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("heading", { name: "Уведомление new" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Прочитать все" })).toBeEnabled();
  });
});
