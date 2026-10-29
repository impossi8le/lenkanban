import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";
import { AssigneeSelector } from "./AssigneeSelector";
import { TagPicker } from "./TagPicker";
import { TaskDetailPanel } from "./TaskDetailPanel";

// Isolate external realtime I/O and unrelated panel sections, keeping the
// selectors, cmdk, Radix popovers and the panel's Escape handler real.
vi.mock("@/lib/socket-client", () => ({ getSocketInstance: () => ({ on: vi.fn(), off: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "user-1" } } }) }));
vi.mock("./ActivityTimeline", () => ({ ActivityTimeline: () => null }));
vi.mock("./TaskAttachments", () => ({ TaskAttachments: () => null }));
vi.mock("./TaskChecklist", () => ({ TaskChecklist: () => null }));
vi.mock("@/components/templates/TemplateDialog", () => ({ TemplateDialog: () => null }));

const owner = { id: "user-1", name: "Анна", email: "anna@example.test", avatarUrl: null };
const tag = { id: "tag-1", name: "Срочно", color: "#ef4444" };
const task: TaskType = {
  id: "task-1", title: "Проверка селекторов", description: "", status: "TODO",
  columnId: "todo", priority: "MEDIUM", position: 1024, projectId: "project-1",
  assignees: [], tags: [], attachments: [], checklistItems: [],
};
const clients: QueryClient[] = [];
function mount(component: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
}
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({ success: true,
    data: url.endsWith("/task-permissions") ? { canChangeStatus: true } : url.endsWith("/members") ? { owner, items: [] } : url.startsWith("/api/tags?") ? [tag] : url.endsWith("/columns") ? [] : {},
  })));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

const cases = [
  { kind: "assignee", trigger: "Исполнители", option: "Анна", empty: "Участники не найдены" },
  { kind: "tag", trigger: "Теги", option: "Срочно", empty: "Теги не найдены" },
] as const;

describe.each(cases)("$kind selector", ({ kind, trigger, option, empty }) => {
  function selector(onChange = vi.fn()) {
    return kind === "assignee"
      ? <AssigneeSelector projectId="project-1" taskId="task-1" selectedAssignees={[]} onAssigneesChange={onChange} />
      : <TagPicker projectId="project-1" taskId="task-1" selectedTags={[]} onTagsChange={onChange} />;
  }

  it("does not claim the list is empty when a real choice exists", async () => {
    mount(selector());
    await userEvent.click(await screen.findByRole("button", { name: trigger }));
    expect(await screen.findByText(option)).toBeVisible();
    expect(screen.queryByText(empty)).not.toBeInTheDocument();
  });

  it("filters choices and lets the keyboard select the remaining match", async () => {
    const onChange = vi.fn();
    mount(selector(onChange));
    await userEvent.click(await screen.findByRole("button", { name: trigger }));
    await screen.findByText(option);
    await userEvent.type(screen.getByRole("combobox"), "zzzz");
    expect(await screen.findByText(empty)).toBeVisible();
    expect(screen.queryByText(option)).not.toBeInTheDocument();
    await userEvent.clear(screen.getByRole("combobox"));
    await userEvent.type(screen.getByRole("combobox"), option);
    await screen.findByRole("option", { name: new RegExp(option) });
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(kind === "assignee" ? [{ id: "temp_user-1", user: owner }] : [{ tag }]));
  });

  it("consumes the first Escape in the popover and the second in the task panel", async () => {
    function Panel() {
      const [open, setOpen] = useState(true);
      return open ? <TaskDetailPanel task={task} onClose={() => setOpen(false)} onSave={vi.fn()} /> : null;
    }
    mount(<Panel />);
    if (kind === "tag") {
      expect(screen.queryByRole("button", { name: trigger })).not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Детали обращения" })).not.toBeInTheDocument();
      return;
    }
    await userEvent.click(await screen.findByRole("button", { name: trigger }));
    await screen.findByPlaceholderText(kind === "assignee" ? "Поиск участников..." : "Поиск тегов...");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByPlaceholderText(kind === "assignee" ? "Поиск участников..." : "Поиск тегов...")).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Детали обращения" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Детали обращения" })).not.toBeInTheDocument());
  });
});
