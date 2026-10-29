import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";

const runtime = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: runtime.apiFetch,
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock("./ProjectTemplateList", () => ({ ProjectTemplateList: () => null }));

import { TemplateDialog } from "./TemplateDialog";
import { TemplateList } from "./TemplateList";
import { TemplatesPanel } from "./TemplatesPanel";

const longTitle = `Исправить-интеграцию-с-внешним-сервисом-${"очень-длинный-сегмент-".repeat(6)}без-пробелов`;
const longTag = `клиент-жалуется-на-повторяющуюся-ошибку-${"сегмент-".repeat(6)}интеграции`;
const longAuthor = `Александра-Екатерина-Константинопольская-${"длинная-фамилия-".repeat(4)}сотрудник`;

const task: TaskType = {
  id: "template-task",
  title: longTitle,
  description: "",
  status: "TODO",
  columnId: "todo",
  priority: "MEDIUM",
  position: 1024,
  projectId: "synthetic-project",
  assignees: [],
  tags: [{ id: "task-tag-1", tag: { id: "tag-1", name: longTag, color: "#ef4444" } }],
  attachments: [],
  checklistItems: [],
};

const template = {
  id: "template-1",
  name: "Шаблон",
  description: null,
  templateTitle: longTitle,
  templateDescription: null,
  priority: "MEDIUM",
  tags: [longTag],
  checklistItems: [],
  createdBy: { id: "author-1", name: longAuthor, email: "author@example.invalid" },
  createdAt: "2026-10-21T10:00:00Z",
};

function wrap(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  runtime.apiFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

it("constrains the save-as-template dialog and wraps an unbroken task title", () => {
  wrap(<TemplateDialog open onOpenChange={vi.fn()} task={task} />);

  const dialog = screen.getByRole("dialog");
  // The shared dialog already caps height; the preview text must also be able
  // to break, otherwise a long title/tag widens the dialog past 320px.
  expect(dialog).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-y-auto");
  expect(dialog).toHaveClass("min-w-0", "p-4", "sm:p-6", "[overflow-wrap:anywhere]");
  expect(dialog).not.toHaveClass("p-6");
  expect(screen.getByText(new RegExp(longTitle.slice(0, 20)))).toBeInTheDocument();
});

it("wraps long template preview rows instead of widening the templates sheet", async () => {
  runtime.apiFetch.mockResolvedValue([template]);
  wrap(<TemplateList projectId="synthetic-project" onUseTemplate={vi.fn()} />);

  const title = await screen.findByText(longTitle);
  const titleRow = title.parentElement as HTMLElement;
  expect(titleRow).toHaveClass("flex-wrap", "min-w-0");
  expect(title).toHaveClass("min-w-0", "[overflow-wrap:anywhere]");

  const tag = screen.getByText(longTag);
  expect(tag).toHaveClass("max-w-full", "whitespace-normal", "break-words");

  const created = screen.getByText(/Создан:/);
  const footer = created.parentElement as HTMLElement;
  expect(footer).toHaveClass("flex-wrap", "gap-2");
  expect(created).toHaveClass("min-w-0", "[overflow-wrap:anywhere]");
});

it("keeps the templates sheet clear of the mobile safe area", () => {
  runtime.apiFetch.mockResolvedValue([]);
  wrap(<TemplatesPanel open onOpenChange={vi.fn()} projectId="synthetic-project" />);

  const sheet = screen.getByRole("dialog");
  expect(sheet).toHaveClass("w-full", "sm:max-w-[540px]", "overflow-y-auto");
  expect(sheet).toHaveClass("pb-[max(1.5rem,env(safe-area-inset-bottom))]");
});
