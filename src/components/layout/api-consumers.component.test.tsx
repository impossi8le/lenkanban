// Highlight marks may split text nodes; assert the exact visible combined text,
// including negative privacy/cache assertions, without depending on markup.
const exactText=(text:string)=>(_:string,node:Element|null)=>Boolean(node&&node.textContent===text&&!Array.from(node.children).some(child=>child.textContent===text));
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "sonner";
import { NotificationBell } from "./notification-bell";
import { CommandPalette } from "./command-palette";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/projects", useSearchParams: () => new URLSearchParams() }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: "MEMBER" } }, status: "authenticated" }) }));
vi.mock("@/hooks/useNotificationSocket", () => ({ useNotificationSocket: () => ({ socket: null, connected: false }) }));

const notification = {
  id: "notice-1", userId: "user-1", type: "TASK_ASSIGNED", title: "Назначена задача",
  message: "Проверить смету", read: false, readAt: null,
  actionUrl: "/projects/project-1/board?task=task-1", metadata: null,
  createdAt: "2026-09-14T10:00:00.000Z",
};
const clients: QueryClient[] = [];
function mount(component: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
  return client;
}
function respond(data: unknown, status = 200) {
  return Response.json(status === 200 ? { success: true, data } : {
    success: false, error: { code: "INTERNAL_ERROR", message: "Сервис недоступен" },
  }, { status });
}
beforeEach(() => {
  // cmdk scrolls selected options; jsdom has no layout/scroll implementation.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

describe("notification API envelopes", () => {
  it("shows the unread count from the envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond({actorId:"user-1",count:3,byProject:{"project-1":3},byTask:{"task-1":3},unscopedCount:0})));
    mount(<NotificationBell />);
    expect(await screen.findByText(exactText("3"))).toBeVisible();
  });

  it("renders notifications from the envelope and opens their task", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("unread-count")
      ? respond({actorId:"user-1",count:1,byProject:{"project-1":1},byTask:{"task-1":1},unscopedCount:0}) : respond([notification])));
    mount(<NotificationBell />);
    fireEvent.click(screen.getByRole("button", { name: "Уведомления" }));
    fireEvent.click(await screen.findByText(exactText("Назначена задача")));
    expect(push).toHaveBeenCalledWith("/projects/project-1/board?task=task-1");
  });

  it("renders the empty notification envelope without crashing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("unread-count")
      ? respond({actorId:"user-1",count:0,byProject:{},byTask:{},unscopedCount:0}) : respond([])));
    mount(<NotificationBell />);
    fireEvent.click(screen.getByRole("button", { name: "Уведомления" }));
    expect(await screen.findByText(exactText("Нет уведомлений"))).toBeVisible();
  });

  it("distinguishes a failed notification request from an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(null, 500)));
    mount(<NotificationBell />);
    fireEvent.click(screen.getByRole("button", { name: "Уведомления" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить уведомления");
    expect(screen.queryByText(exactText("Нет уведомлений"))).not.toBeInTheDocument();
  });
});

async function search() {
  const client = mount(<><CommandPalette /><Toaster /></>);
  fireEvent.click(screen.getByRole("button", { name: "Поиск обращений и направлений" }));
  // The palette chunk is requested on first open, so the dialog body arrives asynchronously.
  fireEvent.change(await screen.findByRole("combobox"), { target: { value: "смета" } });
  return client;
}
describe("command palette API envelopes", () => {
  it("shows matching tasks and projects and navigates to the selected task", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/tasks?")
      ? respond([{ id: "task-1", title: "Проверить смету", projectId: "project-1", project: { name: "Ремонт" } }])
      : respond([{ id: "project-2", name: "Смета проекта", _count: { tasks: 4 } }])));
    await search();
    expect(await screen.findByText(exactText("Смета проекта"))).toBeVisible();
    fireEvent.click(await screen.findByText(exactText("Проверить смету")));
    expect(push).toHaveBeenCalledWith("/projects/project-1/board?task=task-1");
  });

  it("shows no matches for successful empty envelopes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond([])));
    const client = await search();
    await waitFor(() => expect(client.getQueryState(["search", "user-1", "смета"])).toMatchObject({
      status: "success", fetchStatus: "idle",
    }));
    expect(await screen.findByText(exactText("Ничего не найдено."))).toBeVisible();
  });

  it("keeps successful project matches when task search fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/tasks?")
      ? respond(null, 500) : respond([{ id: "project-2", name: "Смета проекта", _count: { tasks: 4 } }])));
    await search();
    expect(await screen.findByText(exactText("Ошибка поиска задач: 500"))).toBeVisible();
    expect(await screen.findByText(exactText("Смета проекта"))).toBeVisible();
  });
});
