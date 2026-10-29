import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MyTasksPage from "@/app/(dashboard)/my-tasks/page";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: "user-1" } } }) }));
vi.mock("@/lib/socket-client", () => ({ getSocketInstance: () => ({ connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() }) }));
vi.mock("next/dynamic", async () => {
  const { Calendar } = await import("@/components/ui/calendar");
  return { default: (loader: () => unknown) => loader.toString().includes("ui/calendar") ? Calendar : () => null };
});
vi.mock("./ActivityTimeline", () => ({ ActivityTimeline: () => null }));
vi.mock("./TaskAttachments", () => ({ TaskAttachments: () => null }));
vi.mock("./TaskChecklist", () => ({ TaskChecklist: () => null }));
vi.mock("@/components/templates/TemplateDialog", () => ({ TemplateDialog: () => null }));

const task = { id: "task-1", title: "Проверить Escape", description: "", projectId: "project-1",
  project: { id: "project-1", name: "Проект" }, status: "TODO", priority: "HIGH", columnId: "todo",
  position: 1024, deadline: null, createdAt: "2026-09-14T10:00:00Z", version: 1,
  assignees: [{ id: "assignment", user: { id: "user-1", name: "Анна", email: "anna@example.test" } }], tags: [], attachments: [], checklistItems: [] };
const clients: QueryClient[] = [];
const externalLayers: HTMLElement[] = [];
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear());
  externalLayers.splice(0).forEach(layer => layer.remove());
  vi.unstubAllGlobals();
});

async function mount(emptyTags = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  let finishSave: (() => void) | undefined;
  let currentTask = { ...task, deadline: task.deadline as string | null };
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "PATCH") return new Promise<Response>(resolve => {
      const body = JSON.parse(String(options.body)) as { changes: { deadline: string | null } };
      finishSave = () => {
        // The successful command and its subsequent authoritative GET describe
        // the same committed version and deadline, as the real API requires.
        currentTask = { ...currentTask, deadline: body.changes.deadline, version: 2 };
        resolve(Response.json({ success: true, data: { taskId: task.id, projectId: task.projectId, version: 2, changed: true, replayed: false } }));
      };
    });
    const data = url.endsWith("/lifecycle") ? { taskId: currentTask.id, projectId: currentTask.projectId, version: currentTask.version, marked: false, deleted: false,
      permissions: { canEditFields: true, canEditDescription: true, canSetDeadline: true, canUseLegacyAssignees: true } }
      : url.endsWith("/task-permissions") ? { canChangeStatus: true } : url === "/api/tasks/task-1?view=details" ? currentTask : url === "/api/tasks?assignedToMe=true&limit=500" ? [currentTask]
      : url.endsWith("/members") ? { owner: { id: "user-1", name: "Анна", email: "anna@example.test", avatarUrl: null }, items: [] }
        : url.startsWith("/api/tags?") ? (emptyTags ? [] : [{ id: "tag-1", name: "Срочно", color: "#ef4444" }])
          : url.endsWith("/columns") ? [{ id: "todo", name: "Входящие", position: 0 }] : [];
    return Response.json({ success: true, data });
  }));
  render(<QueryClientProvider client={client}><MyTasksPage /></QueryClientProvider>);
  await userEvent.click(await screen.findByText("Проверить Escape"));
  await screen.findByRole("dialog", { name: "Детали обращения" });
  // Complete the panel's existing initialization phase before mutating.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
  expect(screen.getByRole("dialog", { name: "Детали обращения" }).contains(document.activeElement)).toBe(true);
  return { client, finishSave: () => finishSave?.() };
}

async function expectPanelOpen() {
  expect(screen.getByRole("dialog", { name: "Детали обращения" })).toBeVisible();
}
async function closePanel() {
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Детали обращения" })).not.toBeInTheDocument());
}

it.each([false, true])("keeps calendar focus across a save (resolved=%s) so Escape dismisses only that layer", async (resolved) => {
  const { finishSave } = await mount();
  const deadlineTrigger = screen.getByRole("button", { name: "Установить" });
  await userEvent.click(deadlineTrigger);
  const calendar = await screen.findByRole("grid");
  const day = within(calendar).getAllByRole("button").find(button => button.textContent === "15");
  expect(day).toBeDefined();
  await userEvent.click(day!);
  await screen.findByText("Сохранение изменений…");
  if (resolved) {
    await act(async () => { finishSave(); });
    await waitFor(() => expect(screen.queryByText("Сохранение изменений…")).not.toBeInTheDocument());
  }
  // A parent render must not move focus out and silently dismiss the calendar.
  expect(screen.getByRole("grid")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("grid")).not.toBeInTheDocument());
  await expectPanelOpen();
  // Only the calendar layer closed: the pending command and its guard stay put.
  if (!resolved) expect(screen.getByText("Сохранение изменений…")).toBeVisible();
  const panel = screen.getByRole("dialog", { name: "Детали обращения" });
  await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
  // The fallback target must be a live, named control of the card, not <body>
  // or a detached node left behind by the dismissed portalled calendar.
  const focusedAfterCalendar = document.activeElement;
  expect(focusedAfterCalendar).toBeInstanceOf(HTMLElement);
  expect(focusedAfterCalendar).not.toBe(document.body);
  expect((focusedAfterCalendar as HTMLElement).isConnected).toBe(true);
  expect(focusedAfterCalendar).toHaveAccessibleName();
  if (resolved) expect(deadlineTrigger).toHaveFocus();
  if (!resolved) {
    fireEvent.click(screen.getByRole("dialog", { name: "Детали обращения" }).previousElementSibling!); await expectPanelOpen();
    await userEvent.keyboard("{Escape}"); await expectPanelOpen();
    await act(async () => { finishSave(); });
    await waitFor(() => {
      expect(screen.queryByText("Сохранение изменений…")).not.toBeInTheDocument();
      expect(screen.queryByText("Обновляем карточку…")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("dialog", { name: "Детали обращения" }).contains(document.activeElement)).toBe(true);
  }
  // After the command and authoritative read settle, one Escape closes the card
  // and the list title that opened it receives focus again.
  await closePanel();
  await waitFor(() => expect(screen.getByRole("button", { name: "Открыть задачу «Проверить Escape»" })).toHaveFocus());
});

it.each([false, true])("preserves intentional outside focus when a pending calendar closes (other dialog=%s)", async (otherDialog) => {
  const { finishSave } = await mount();
  await userEvent.click(screen.getByRole("button", { name: "Установить" }));
  const calendar = await screen.findByRole("grid");
  const day = within(calendar).getAllByRole("button").find(button => button.textContent === "15");
  expect(day).toBeDefined();
  await userEvent.click(day!);
  await screen.findByText("Сохранение изменений…");

  const layer = document.createElement("div");
  if (otherDialog) {
    layer.setAttribute("role", "dialog");
    layer.setAttribute("aria-modal", "true");
    layer.setAttribute("aria-label", "Другая открытая форма");
  }
  const deliberateTarget = document.createElement("button");
  deliberateTarget.textContent = "Другое действие";
  layer.append(deliberateTarget); document.body.append(layer); externalLayers.push(layer);
  // Focus outside is an intentional interaction, distinct from Radix being
  // unable to restore its disabled deadline trigger after Escape.
  act(() => deliberateTarget.focus());
  await waitFor(() => expect(screen.queryByRole("grid")).not.toBeInTheDocument());
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  expect(deliberateTarget).toHaveFocus();
  await expectPanelOpen();

  await act(async () => { finishSave(); });
  await waitFor(() => {
    expect(screen.queryByText("Сохранение изменений…")).not.toBeInTheDocument();
    expect(screen.queryByText("Обновляем карточку…")).not.toBeInTheDocument();
  });
  expect(deliberateTarget).toHaveFocus();
});

it("hides tags and checklist instead of creating nested picker layers", async () => {
  await mount();
  expect(screen.queryByRole("button", { name: "Теги" })).not.toBeInTheDocument();
  expect(screen.queryByText("ЧЕК-ЛИСТ")).not.toBeInTheDocument();
  await closePanel();
});
it("dismisses the permitted assignee picker before the panel", async () => {
  await mount();
  await userEvent.click(await screen.findByRole("button", { name: /Исполнители/ }));
  await screen.findByPlaceholderText("Поиск участников...");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByPlaceholderText("Поиск участников...")).not.toBeInTheDocument());
  await expectPanelOpen();
  await closePanel();
});

it("closes the panel with one Escape when no nested layer is open", async () => {
  await mount();
  await closePanel();
});

it("renders the demo relative creation time on the card", async () => {
  await mount(); await closePanel();
  const card = screen.getByRole("button", { name: "Открыть задачу «Проверить Escape»" }).closest(".request-card")!;
  expect(card.querySelector("time")).toHaveAttribute("dateTime", new Date(task.createdAt).toISOString());
});
