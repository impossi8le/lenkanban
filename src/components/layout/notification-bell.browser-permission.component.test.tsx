import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationBell } from "./notification-bell";

vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: "permission-actor" } } }) }));
const router = { push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/hooks/useNotificationSocket", () => ({ useNotificationSocket: () => ({ socket: null, connected: false }) }));

class PermissionNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>();
}
const clients: QueryClient[] = [];
beforeEach(() => {
  PermissionNotification.permission = "default";
  PermissionNotification.requestPermission.mockReset();
  vi.stubGlobal("Notification", PermissionNotification);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({ success: true, data: url.endsWith("unread-count") ? { count: 0 } : [] })));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><NotificationBell /></QueryClientProvider>);
}
async function open() {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Уведомления" }));
  await screen.findByRole("dialog", { name: "Уведомления" });
}

it("explains a pending native request, prevents duplicate clicks and shows the ungranted outcome", async () => {
  let finish!: (permission: NotificationPermission) => void;
  PermissionNotification.requestPermission.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await open();
  fireEvent.click(await screen.findByRole("button", { name: "Включить уведомления на компьютере" }));
  expect(screen.getByRole("button", { name: "Ожидаем ответ браузера…" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Пока можно продолжать работу");
  expect(screen.getByRole("button", { name: "Уведомления" })).toBeEnabled();
  expect(PermissionNotification.requestPermission).toHaveBeenCalledOnce();
  await act(async () => { finish("default"); });
  expect(await screen.findByRole("button", { name: "Включить уведомления на компьютере" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent("Разрешение не получено");
});

it("explains unsupported notification APIs instead of showing an empty section", async () => {
  vi.stubGlobal("Notification", undefined);
  await open();
  expect(await screen.findByText(/Этот браузер не поддерживает системные уведомления/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Включить уведомления на компьютере" })).not.toBeInTheDocument();
});

it("uses one bell for events and browser-notification settings", async () => {
  mount();
  const settings = await screen.findByRole("button", { name: "Уведомления" });
  expect(settings).toBeVisible();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Уведомления на компьютере" })).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(settings);
  expect(await screen.findByRole("dialog", { name: "Уведомления" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Включить уведомления на компьютере" })).toBeEnabled();
  expect(PermissionNotification.requestPermission).not.toHaveBeenCalled();
});

it("shows recoverable Chrome instructions for a denied permission without requesting again", async () => {
  PermissionNotification.permission = "denied";
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Уведомления" }));
  expect(await screen.findByText("Уведомления на компьютере заблокированы в настройках сайта")).toBeVisible();
  expect(screen.getByText("Как включить уведомления в Chrome")).toBeVisible();
  expect(screen.getByRole("link", { name: "Инструкция Chrome" })).toHaveAttribute("href", "https://support.google.com/chrome/answer/3220216");
  expect(screen.queryByRole("button", { name: "Включить уведомления на компьютере" })).not.toBeInTheDocument();
  expect(PermissionNotification.requestPermission).not.toHaveBeenCalled();
});

it("reflects permission restored in site settings after window focus", async () => {
  PermissionNotification.permission = "denied";
  await open();
  PermissionNotification.permission = "granted";
  fireEvent.focus(window);
  expect(await screen.findByText("Уведомления на компьютере включены")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Уведомления на компьютере" })).not.toBeInTheDocument();
  expect(PermissionNotification.requestPermission).not.toHaveBeenCalled();
});

it("removes the permission prompt after the native API grants permission", async () => {
  PermissionNotification.requestPermission.mockResolvedValue("granted");
  await open();
  fireEvent.click(await screen.findByRole("button", { name: "Включить уведомления на компьютере" }));
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "Включить уведомления на компьютере" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Разрешение не получено/)).not.toBeInTheDocument();
  expect(screen.getByText("Уведомления на компьютере включены")).toBeVisible();
});

it("keeps an explicit retry available if the native request rejects", async () => {
  PermissionNotification.requestPermission.mockRejectedValue(new Error("native permission request failed"));
  await open();
  fireEvent.click(await screen.findByRole("button", { name: "Включить уведомления на компьютере" }));
  await act(async () => {});
  expect(screen.getByRole("button", { name: "Включить уведомления на компьютере" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent("Разрешение не получено");
});
