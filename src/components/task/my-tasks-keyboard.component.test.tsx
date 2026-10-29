import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), replace: vi.fn(),
  session: { status: "authenticated", data: { user: { id: "actor-A" } } },
}));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.get, apiPatch: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("next-auth/react", () => ({ useSession: () => mocks.session }));
vi.mock("@/hooks/useTaskDetailRealtime", () => ({ useTaskDetailRealtime: () => {} }));
vi.mock("@/lib/socket-client", () => ({ getSocketInstance: () => ({ connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./ActivityTimeline", () => ({ ActivityTimeline: () => null }));
vi.mock("./TaskAttachments", () => ({ TaskAttachments: () => null }));
vi.mock("./TaskChecklist", () => ({ TaskChecklist: () => null }));
vi.mock("./TaskChatPanel", () => ({ TaskChatPanel: () => null }));
vi.mock("@/components/templates/TemplateDialog", () => ({ TemplateDialog: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
import MyTasksPage from "@/app/(dashboard)/my-tasks/page";

// Page, authorized loader, command controller and panel focus behavior are real.
// Peripheral editor/history/chat content and network responses are isolated.
const first = {
  id: "task-A", title: "Первая задача", projectId: "project-1",
  project: { id: "project-1", name: "Проект" }, status: "TODO", priority: "HIGH",
  columnId: "todo", column: { id: "todo", name: "Входящие", color: "#334455" },
  description: "", position: 1, deadline: null, createdAt: "2026-10-20T10:00:00Z", version: 1,
  assignees: [], tags: [], attachments: [], checklistItems: [],
};
const second = { ...first, id: "task-B", title: "Вторая задача", createdAt: "2026-10-19T10:00:00Z" };
type TaskFixture = typeof first;
let rows: TaskFixture[] = [];
let pendingRead: Promise<TaskFixture> | null = null;
const clients: QueryClient[] = [];
const externalNodes: HTMLElement[] = [];
const listPath = "/api/tasks?assignedToMe=true&limit=500";
function detailReads() { return mocks.get.mock.calls.filter(([url]) => /\/api\/tasks\/[^?]+\?view=details/.test(url)); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const tree = () => <QueryClientProvider client={client}><MyTasksPage /></QueryClientProvider>;
  const view = render(tree());
  return { client, rerenderPage: () => view.rerender(tree()) };
}
async function opener(task = first) { return screen.findByRole("button", { name: `Открыть задачу «${task.title}»` }); }
async function panel() {
  const current = await screen.findByRole("dialog", { name: "Детали обращения" });
  await waitFor(() => expect(current.contains(document.activeElement)).toBe(true));
  return current;
}
function closeButton(current: HTMLElement) { return within(current).getByRole("button", { name: "Закрыть окно" }); }
async function settleFocusFrame() {
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
}

beforeEach(() => {
  rows = [first, second]; pendingRead = null;
  mocks.get.mockReset(); mocks.replace.mockReset(); mocks.session.data.user.id = "actor-A";
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "DELETE") rows = rows.filter(task => url !== `/api/tasks/${task.id}`);
    return new Response(null, { status: 204 });
  }));
  mocks.get.mockImplementation(async (url: string) => {
    if (url === "/api/notifications/unread-count") return { actorId: mocks.session.data.user.id, count: 0, byProject: {}, byTask: {}, unscopedCount: 0 };
    if (url === listPath) return rows;
    if (url.includes("?view=details")) return pendingRead ?? (url.includes(first.id) ? first : second);
    if (url.endsWith("/members")) return { owner: { id: "actor-A", name: "Тест", email: "test@example.test", avatarUrl: null }, items: [] };
    if (url.endsWith("/columns")) return [{ id: "todo", name: "Входящие", position: 0 }];
    return [];
  });
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear());
  externalNodes.splice(0).forEach(node => node.remove());
  vi.unstubAllGlobals();
});

describe("MyTasks keyboard opening and focus lifecycle", () => {
  it.each(["{Enter}", " "])("opens once with %s and authorizes anew after closing", async key => {
    const user = userEvent.setup(); mount();
    const title = await opener();
    expect(title.tagName).toBe("BUTTON");
    title.focus(); await user.keyboard(key);
    const current = await panel();
    expect(detailReads()).toHaveLength(1);
    fireEvent.click(title); fireEvent.click(title);
    expect(detailReads()).toHaveLength(1);
    fireEvent.click(closeButton(current));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(title).toHaveFocus());
    await user.keyboard(key); await panel();
    expect(detailReads()).toHaveLength(2);
  });

  it("reaches the title buttons with Tab and opens the focused task with Enter", async () => {
    const user = userEvent.setup(); mount();
    const firstTitle = await opener(first);
    const secondTitle = await opener(second);
    // Category is the last enabled filter before the keyboard-scrollable board.
    screen.getByRole("combobox", { name: "Категория" }).focus();
    await user.tab();
    expect(screen.getByRole("region", { name: "Колонки обращений" })).toHaveFocus();
    await user.tab(); expect(firstTitle).toHaveFocus();
    await user.tab(); expect(secondTitle).toHaveFocus();
    await user.tab({ shift: true }); expect(firstTitle).toHaveFocus();
    await user.keyboard("{Enter}");
    const current = await panel();
    expect(detailReads()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "В проект" })).not.toBeInTheDocument();

    fireEvent.click(closeButton(current));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(firstTitle).toHaveFocus());
  });

  it("opens the common detail panel from the demo card without a separate project action", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await opener()); await panel();
    expect(screen.queryByRole("button", { name: "В проект" })).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled(); expect(detailReads()).toHaveLength(1);
  });

  it("closes a pending authorized read with Escape and restores its title opener", async () => {
    const read = deferred<TaskFixture>(); pendingRead = read.promise;
    const user = userEvent.setup(); mount(); const title = await opener();
    title.focus(); await user.keyboard("{Enter}");
    const loader = await screen.findByRole("dialog", { name: "Загрузка карточки задачи" });
    await waitFor(() => expect(loader.contains(document.activeElement)).toBe(true));
    fireEvent.click(title);
    expect(detailReads()).toHaveLength(1);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(title).toHaveFocus());
    await act(async () => { read.resolve(first); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([false, true])("restores a surviving title or heading after deletion (empty=%s)", async empty => {
    const user = userEvent.setup(); const view = mount();
    await user.click(await opener()); const current = await panel();
    // Exercise list rerender/reordering while the selected editor remains open.
    rows = [{ ...second, createdAt: "2026-10-21T10:00:00Z" }, first];
    await act(async () => { view.client.setQueryData(["my-tasks", "actor-A", "assigned", false], rows); });
    await waitFor(() => {
      const reorderedTitles = screen.getAllByRole("button", { name: /^Открыть задачу «(Первая|Вторая) задача»$/ });
      expect(reorderedTitles.map(button => button.textContent)).toEqual([second.title, first.title]);
    });
    if (empty) rows = [first];
    fireEvent.click(within(current).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("button", { name: `Открыть задачу «${first.title}»` })).not.toBeInTheDocument());
    const fallback = empty ? screen.getByRole("heading", { name: "Я исполнитель" }) : await opener(second);
    await waitFor(() => expect(fallback).toHaveFocus());
    expect(fetch).toHaveBeenCalledWith("/api/tasks/task-A", { method: "DELETE" });
  });

  it("keeps heading levels sequential from the page title to task cards", async () => {
    mount();
    await opener();
    const levels = screen.getAllByRole("heading").map(node => Number(node.tagName.slice(1)));
    expect(levels[0]).toBe(1);
    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index]).toBeLessThanOrEqual(levels[index - 1] + 1);
    }
  });

  it("exposes the demo search, urgency and category controls", async () => {
    mount();
    await opener();
    expect(screen.getByRole("textbox", { name: "Поиск обращений" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Категория" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Срочные" })).toHaveAttribute("aria-pressed", "false");
  });

  it("does not restore old-account focus after the actor changes", async () => {
    const read = deferred<TaskFixture>(); pendingRead = read.promise;
    const user = userEvent.setup(); const view = mount(); await user.click(await opener());
    await screen.findByRole("dialog", { name: "Загрузка карточки задачи" });
    const deliberate = document.createElement("button"); deliberate.textContent = "Другая область";
    document.body.append(deliberate); externalNodes.push(deliberate);
    act(() => { mocks.session.data.user.id = "actor-B"; view.rerenderPage(); });
    deliberate.focus();
    await act(async () => { read.resolve(first); });
    await settleFocusFrame();
    expect(deliberate).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([false, true])("preserves deliberately moved focus on close (replacement modal=%s)", async modal => {
    const user = userEvent.setup(); mount(); await user.click(await opener()); const current = await panel();
    const layer = document.createElement("div");
    if (modal) { layer.setAttribute("role", "dialog"); layer.setAttribute("aria-modal", "true"); }
    const deliberate = document.createElement("button"); deliberate.textContent = "Другое действие";
    layer.append(deliberate); document.body.append(layer); externalNodes.push(layer);
    deliberate.focus(); fireEvent.click(closeButton(current));
    await waitFor(() => expect(current).not.toBeInTheDocument());
    await settleFocusFrame();
    expect(deliberate).toHaveFocus();
  });
});
