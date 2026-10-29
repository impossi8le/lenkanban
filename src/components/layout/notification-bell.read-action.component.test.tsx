import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationBell } from "./notification-bell";

const controls = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "actor" } }, status: "authenticated" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: controls.push }) }));
vi.mock("@/hooks/useNotificationSocket", () => ({ useNotificationSocket: () => ({ socket: null, connected: false }) }));
vi.mock("@/hooks/useBrowserNotifications", () => ({ useBrowserNotifications: () => ({ ready: false }) }));

let notices: { id: string; title: string; read: boolean; actionUrl: string; metadata?: unknown; message?: string; currentTask?: { taskId: string; projectId: string; phase: { code: string; label: string } } }[];
let finishPatch: (() => void) | undefined;
let rejectPatch: boolean;
const calls: { url: string; method: string }[] = [];
const clients: QueryClient[] = [];

beforeEach(() => {
  controls.push.mockReset(); calls.length = 0; finishPatch = undefined; rejectPatch = false;
  notices = [
    { id: "one", title: "Счёт подготовлен", read: false, actionUrl: "/projects/bank/board?task=one" },
    { id: "two", title: "Платёж найден", read: false, actionUrl: "/projects/bank/board?task=two" },
  ];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? "GET"; calls.push({ url, method });
    if (method === "PATCH") {
      await new Promise<void>(resolve => { finishPatch = resolve; });
      if (rejectPatch) return Response.json({ success: false, error: { message: "Ошибка" } }, { status: 500 });
      notices = notices.map(notice => url.endsWith("mark-all-read") || url.endsWith("/" + notice.id) ? { ...notice, read: true } : notice);
      return Response.json({ success: true, data: null });
    }
    if (url.endsWith("unread-count")) { const unread = notices.filter(notice => !notice.read); return Response.json({ success: true, data: { actorId: "actor", count: unread.length, byProject: { bank: unread.length }, byTask: Object.fromEntries(unread.map(notice => [notice.id, 1])), unscopedCount: 0 } }); }
    return Response.json({ success: true, data: notices.map(notice => ({ type: "task_assigned", message: "Информация по обращению", readAt: null, metadata: null, createdAt: "2026-10-28T10:00:00Z", ...notice })) });
  }));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><NotificationBell /></QueryClientProvider>);
  await screen.findByText("2");
  fireEvent.click(screen.getByRole("button", { name: "Уведомления" }));
  const popup = await screen.findByRole("dialog", { name: "Уведомления" });
  await within(popup).findByText("Платёж найден");
  return popup;
}

it("separates historical queue entry from the current board phase and refreshes after attachment commit", async () => {
  notices[0] = { ...notices[0], title: "Заявка в очереди", message: "PRIVATE_LEGACY ожидает в очереди",
    metadata: { reason: "queue", taskId: "one", projectId: "bank" },
    currentTask: { taskId: "one", projectId: "bank", phase: { code: "WAITING", label: "Ждут обработки" } } };
  const popup = await mount();
  expect(within(popup).getByText("Заявка поступила в очередь")).toBeVisible();
  expect(within(popup).getByText("Сейчас: Ждут обработки")).toBeVisible();
  expect(screen.queryByText(/ожидает в очереди|PRIVATE_LEGACY/)).not.toBeInTheDocument();
  notices[0] = { ...notices[0], currentTask: { taskId: "one", projectId: "bank", phase: { code: "INVOICED", label: "Со счётом" } } };
  await act(async () => { window.dispatchEvent(new CustomEvent("beznal:attachment-committed", { detail: { taskId: "one" } })); });
  expect(await within(popup).findByText("Сейчас: Со счётом")).toBeVisible();
  expect(screen.queryByText("Сейчас: Ждут обработки")).not.toBeInTheDocument();
  expect(calls.some(call => call.method === "PATCH")).toBe(false);
  expect(controls.push).not.toHaveBeenCalled();
  notices[0] = { ...notices[0], currentTask: { taskId: "one", projectId: "bank", phase: { code: "CLOSED", label: "Закрыто" } } };
  await act(async () => { clients.at(-1)!.setQueryData(["tasks", "bank"], []); });
  expect(await within(popup).findByText("Сейчас: Закрыто")).toBeVisible();
  expect(calls.some(call => call.method === "PATCH")).toBe(false);
});

it("marks only the selected notice without navigating or closing; updates its dot and badge after success", async () => {
  const popup = await mount();
  const buttons = within(popup).getAllByRole("button", { name: "Отметить прочитанным" });
  expect(buttons[0]).toHaveAccessibleDescription("Счёт подготовлен");
  expect(buttons[0]).toHaveAttribute("title", "Отметить прочитанным");
  expect(buttons[0]).toHaveClass("h-8", "w-8", "min-w-8");
  expect(buttons[0].textContent).toBe("");
  expect(popup.querySelector("button button")).toBeNull();
  expect(within(popup).getAllByRole("img", { name: "Непрочитано" })).toHaveLength(2);
  fireEvent.click(buttons[0]);
  await waitFor(() => expect(finishPatch).toBeTypeOf("function"));
  expect(buttons[0]).toBeDisabled(); expect(buttons[0]).toHaveAttribute("aria-busy", "true");
  fireEvent.click(buttons[0]);
  expect(calls.filter(call => call.method === "PATCH")).toEqual([{ url: "/api/notifications/one", method: "PATCH" }]);
  expect(controls.push).not.toHaveBeenCalled(); expect(popup).toBeVisible();
  await act(async () => finishPatch?.());
  await waitFor(() => expect(screen.getByRole("button", { name: "Уведомления" })).toHaveTextContent("1"));
  expect(within(popup).getAllByRole("img", { name: "Непрочитано" })).toHaveLength(1);
  expect(within(popup).getByRole("button", { name: "Прочитано" })).toBeDisabled();
  expect(within(popup).getByRole("button", { name: "Отметить прочитанным" })).toBeEnabled();
  expect(controls.push).not.toHaveBeenCalled(); expect(popup).toBeVisible();
});

it("keeps unread state and offers retry when single PATCH fails", async () => {
  rejectPatch = true; const popup = await mount();
  fireEvent.click(within(popup).getAllByRole("button", { name: "Отметить прочитанным" })[0]);
  await waitFor(() => expect(finishPatch).toBeTypeOf("function"));
  await act(async () => finishPatch?.());
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось отметить уведомление");
  expect(within(popup).getAllByRole("img", { name: "Непрочитано" })).toHaveLength(2);
  expect(within(popup).getAllByRole("button", { name: "Отметить прочитанным" })[0]).toBeEnabled();
  expect(screen.getByRole("button", { name: "Уведомления" })).toHaveTextContent("2");
  expect(controls.push).not.toHaveBeenCalled(); expect(popup).toBeVisible();
});

it("opens a task notification without prematurely reading an unloaded request", async () => {
  notices[0].metadata = { taskId: "one", projectId: "bank" };
  const popup = await mount();
  fireEvent.click(within(popup).getByRole("button", { name: /Счёт подготовлен/ }));
  expect(controls.push).toHaveBeenCalledWith("/projects/bank/board?task=one");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(calls.filter(call => call.method === "PATCH")).toEqual([]);
});

it("preserves mark-all as a separate action without opening requests", async () => {
  const popup = await mount();
  fireEvent.click(within(popup).getByRole("button", { name: "Прочитать все" }));
  await waitFor(() => expect(finishPatch).toBeTypeOf("function"));
  expect(calls.filter(call => call.method === "PATCH")).toEqual([{ url: "/api/notifications/mark-all-read", method: "PATCH" }]);
  await act(async () => finishPatch?.());
  await waitFor(() => expect(within(popup).queryByRole("img", { name: "Непрочитано" })).not.toBeInTheDocument());
  expect(controls.push).not.toHaveBeenCalled(); expect(popup).toBeVisible();
});
