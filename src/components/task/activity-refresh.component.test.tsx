import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityTimeline } from "./ActivityTimeline";
import { AssigneeSelector } from "./AssigneeSelector";
import { TagPicker } from "./TagPicker";
import { TaskChecklist } from "./TaskChecklist";
import { TaskDetailPage } from "@/app/(dashboard)/projects/[id]/tasks/[taskId]/TaskDetailPage";
import { TaskModalPage } from "@/app/(dashboard)/projects/[id]/board/@modal/(..)tasks/[taskId]/TaskModalPage";
import MyTasksPage from "@/app/(dashboard)/my-tasks/page";
import type { TaskType } from "@/components/kanban/Card";

// Activity descriptions remain real; their server-only writer dependencies
// and external sockets/navigation are not used by this client interaction.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ dbLogger: {} }));
vi.mock("@/lib/socket-client", () => {
  const socket = { connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() };
  return { getSocketInstance: () => socket };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: "user-1" } } }) }));
// Drive the owners' public save callback; each owner's real save transport and the
// real ActivityTimeline share a real QueryClient and mocked network only.
vi.mock("./TaskDetailPanel", () => ({ TaskDetailPanel: ({ task, onSave, saveStatus }: {
  task: TaskType; onSave: (id: string, updates: { title: string }) => void; saveStatus?: React.ReactNode;
}) => <>{saveStatus}<button onClick={() => onSave(task.id, { title: "Изменено" })}>Сохранить задачу</button></> }));

const item = { id: "item-1", taskId: "task-1", text: "Проверить", completed: false,
  position: 1024, createdAt: "2026-09-14T10:00:00Z", updatedAt: "2026-09-14T10:00:00Z" };
const user = { id: "user-1", name: "Анна", email: "anna@example.test", avatarUrl: null };
const tag = { id: "tag-1", name: "Срочно", color: "#ef4444" };
const task: TaskType = { id: "task-1", title: "Тестовая задача", projectId: "project-1",
  description: "", status: "TODO", columnId: "todo", priority: "MEDIUM", position: 1024,
  version: 7, assignees: [], tags: [], attachments: [], checklistItems: [] };
const clients: QueryClient[] = [];
function envelope(data: unknown, ok = true) {
  return Response.json(ok ? { success: true, data } : { success: false,
    error: { code: "INTERNAL_ERROR", message: "Сохранение не выполнено" } }, { status: ok ? 200 : 500 });
}
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  // Existing components log every operation, including successful toggles, as errors.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

const cases = ["assignees", "tags", "checklist-add", "checklist-toggle", "checklist-edit", "checklist-delete", "detail-page", "modal-page", "my-tasks"] as const;
type Case = typeof cases[number];
function editor(kind: Case) {
  if (kind === "assignees") return <AssigneeSelector projectId="project-1" taskId="task-1" selectedAssignees={[]} onAssigneesChange={vi.fn()} />;
  if (kind === "tags") return <TagPicker projectId="project-1" taskId="task-1" selectedTags={[]} onTagsChange={vi.fn()} />;
  if (kind === "detail-page") return <TaskDetailPage projectId="project-1" taskId="task-1" task={task} />;
  if (kind === "modal-page") return <TaskModalPage projectId="project-1" taskId="task-1" task={{ ...task, version: 7 }} initialActorId="user-1" />;
  if (kind === "my-tasks") return <MyTasksPage />;
  return <TaskChecklist taskId="task-1" items={[item]} onUpdate={vi.fn()} />;
}
async function save(kind: Case) {
  if (kind === "assignees" || kind === "tags") {
    await userEvent.click(await screen.findByRole("button", { name: kind === "assignees" ? "Исполнители" : "Теги" }));
    await userEvent.click(await screen.findByRole("option", { name: kind === "assignees" ? /Анна/ : "Срочно" }));
  } else if (kind === "checklist-add") {
    await userEvent.click(screen.getByRole("button", { name: "Добавить пункт" }));
    await userEvent.type(screen.getByPlaceholderText("Текст пункта..."), "Новый пункт");
    await userEvent.click(screen.getByRole("button", { name: "Добавить элемент" }));
  } else if (kind === "checklist-toggle") {
    await userEvent.click(screen.getByRole("checkbox", { name: "Проверить" }));
  } else if (kind === "checklist-edit") {
    await userEvent.click(screen.getByRole("button", { name: "Редактировать" }));
    await userEvent.type(screen.getByRole("textbox"), " снова");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  } else if (kind === "checklist-delete") {
    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));
  } else {
    if (kind === "my-tasks") await userEvent.click(await screen.findByText("Тестовая задача"));
    await userEvent.click(await screen.findByRole("button", { name: "Сохранить задачу" }));
  }
}

describe.each(cases)("%s history refresh", (kind) => {
  it.each([true, false])("refreshes only after a successful server response (success=%s)", async (ok) => {
    const commandConsumer = ["modal-page", "detail-page", "my-tasks"].includes(kind);
    const initialDetailsReads = kind === "my-tasks" ? 1 : 0;
    let finishWrite: ((response: Response) => void) | undefined;
    let historyReads = 0;
    let detailsReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method && options.method !== "GET") {
        if (commandConsumer) {
          expect(options.method).toBe("PATCH");
          expect(JSON.parse(String(options.body))).toEqual({
            operationId: expect.any(String), expectedVersion: 7, changes: { title: "Изменено" },
          });
        }
        return new Promise<Response>((resolve) => { finishWrite = resolve; });
      }
      if (commandConsumer && url === "/api/tasks/task-1?view=details") {
        detailsReads++;
        return envelope({ ...task, ...(finishWrite ? { title: "Изменено", version: 8 } : {}) });
      }
      if (url.startsWith("/api/activities?")) {
        historyReads++;
        return envelope(finishWrite ? [{ id: "activity-1", action: "title_changed", oldValue: null,
          newValue: null, createdAt: "2026-09-14T10:00:00Z", user: { ...user, name: "Сохранено" } }] : []);
      }
      if (url.endsWith("/task-permissions")) return envelope({ canChangeStatus: true });
      if (url.endsWith("/task-permissions")) return envelope({ canChangeStatus: true });
    if (url.endsWith("/members")) return envelope({ owner: user, items: [] });
      if (url.startsWith("/api/tags?")) return envelope([tag]);
      if (url === "/api/tasks?assignedToMe=true&limit=500") return envelope([{ ...task, deadline: null,
        createdAt: "2026-09-14T10:00:00Z", project: { id: "project-1", name: "Проект" } }]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    clients.push(client);
    client.setQueryData(["activities", "task-2"], []);
    client.setQueryData(["activities", "task-1", "other-actor"], []);
    client.setQueryData(["activity-metadata", "task-1"], []);
    client.setQueryData(["activities", "task-2", "user-1"], []);
    render(<QueryClientProvider client={client}>{editor(kind)}<ActivityTimeline taskId="task-1" /></QueryClientProvider>);
    await screen.findByText("Пока нет действий");
    await save(kind);
    await waitFor(() => expect(finishWrite).toBeTypeOf("function"));
    // Optimistic UI callbacks must not invalidate history before persistence.
    expect(historyReads).toBe(1);
    expect(detailsReads).toBe(initialDetailsReads);
    expect(screen.queryByText(/Сохранено/)).not.toBeInTheDocument();
    await act(async () => { finishWrite!(envelope(commandConsumer
      ? { taskId: task.id, projectId: task.projectId, version: 8, changed: true, replayed: false }
      : item, ok)); });
    await waitFor(() => expect(client.isMutating()).toBe(0));
    if (ok) {
      expect(await screen.findByText(/Сохранено/)).toBeVisible();
      expect(historyReads).toBe(2);
      expect(detailsReads).toBe(initialDetailsReads + (commandConsumer ? 1 : 0));
    } else {
      if (commandConsumer) await screen.findByRole("button", { name: "Повторить сохранение" });
      expect(historyReads).toBe(1);
      expect(detailsReads).toBe(initialDetailsReads);
      expect(screen.getByText("Пока нет действий")).toBeVisible();
    }
    expect(client.getQueryState(["activities", "task-2"])?.isInvalidated).toBe(false);
    // Every actor cache for this task becomes stale after a committed action;
    // only the mounted actor query refetches. Other tasks/namespaces stay intact.
    expect(client.getQueryState(["activities", "task-1", "other-actor"])?.isInvalidated).toBe(ok);
    expect(client.getQueryState(["activities", "task-2", "user-1"])?.isInvalidated).toBe(false);
    expect(client.getQueryState(["activity-metadata", "task-1"])?.isInvalidated).toBe(false);
  });
});

it.each(["assignees", "tags"] as const)("%s keeps a pending save bound to task A after rendering task B", async (kind) => {
  let finishWrite: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "PUT") {
      if (url !== `/api/tasks/task-A/${kind}`) throw new Error(`Wrong save target: ${url}`);
      return new Promise<Response>((resolve) => { finishWrite = resolve; });
    }
    if (url.endsWith("/task-permissions")) return envelope({ canChangeStatus: true });
    if (url.endsWith("/members")) return envelope({ owner: user, items: [] });
    if (url.startsWith("/api/tags?")) return envelope([tag]);
    throw new Error(`Unexpected request: ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  for (const suffix of ["A", "B"]) {
    client.setQueryData(["activities", `task-${suffix}`], []);
    client.setQueryData(["tasks", `project-${suffix}`], []);
  }
  function selector(suffix: string) {
    return <QueryClientProvider client={client}>{kind === "assignees"
      ? <AssigneeSelector taskId={`task-${suffix}`} projectId={`project-${suffix}`} selectedAssignees={[]} onAssigneesChange={vi.fn()} />
      : <TagPicker taskId={`task-${suffix}`} projectId={`project-${suffix}`} selectedTags={[]} onTagsChange={vi.fn()} />}</QueryClientProvider>;
  }
  const view = render(selector("A"));
  await save(kind);
  await waitFor(() => expect(finishWrite).toBeTypeOf("function"));
  view.rerender(selector("B"));
  await act(async () => { finishWrite!(envelope({})); });
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(client.getQueryState(["activities", "task-A"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(["tasks", "project-A"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(["activities", "task-B"])?.isInvalidated).toBe(false);
  expect(client.getQueryState(["tasks", "project-B"])?.isInvalidated).toBe(false);
});
