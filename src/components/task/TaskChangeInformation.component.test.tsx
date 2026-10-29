import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";
import { TaskCardDates, TaskChangeDetails, TaskChangesProvider } from "./TaskChangeInformation";
const state = vi.hoisted(() => ({ unseen: true, unknown: false }));
vi.mock("@/hooks/useTaskChanges", () => ({ useTaskChanges: () => ({ actorId: "actor", isFetchedAfterMount: true, isFetching: false, isError: state.unknown,
  data: state.unknown ? undefined : { actorId: "actor", byTask: { task: { snapshotToken: "signed", unseen: state.unseen,
    latestVisibleChange: { kind: "comment_added", label: "Добавлен комментарий", at: "2026-10-28T14:11:00Z" } } } } }) }));
vi.mock("@/hooks/useTaskChangeViewed", () => ({ useTaskChangeViewed: () => ({ status: "seen", retry: vi.fn() }) }));
vi.mock("@/hooks/useNotificationSummary", () => ({ useNotificationSummary: () => ({ byTask: {} }) }));
const task = { id: "task", projectId: "board", title: "Synthetic", position: 0, priority: "LOW", createdAt: "2026-10-28T14:10:00Z", updatedAt: "2026-10-28T14:11:00Z" } as TaskType;
afterEach(() => { cleanup(); state.unseen = true; state.unknown = false; });
it("places the unread change beside creation, then hides it after viewing", () => {
  const client = new QueryClient();
  const contents = () => <QueryClientProvider client={client}><TaskChangesProvider projectId="board" enabled><TaskCardDates task={task}/></TaskChangesProvider></QueryClientProvider>;
  const view = render(contents());
  const notice = screen.getByLabelText("Непросмотренное изменение");
  expect(notice).toHaveTextContent("Добавлен комментарий");
  expect(notice.parentElement).toHaveAttribute("aria-label", "Создание обращения, московское время");
  expect(screen.getByLabelText("Последнее обновление, московское время")).toHaveTextContent("28.10.2026, 17:11");
  state.unseen = false; view.rerender(contents());
  expect(screen.queryByLabelText("Непросмотренное изменение")).not.toBeInTheDocument();
});
it("keeps the change inside an opened card after the receipt", () => {
  state.unseen = false;
  render(<QueryClientProvider client={new QueryClient()}><TaskChangeDetails task={task}/></QueryClientProvider>);
  expect(screen.getByText("Добавлен комментарий")).toBeVisible();
  expect(screen.getByLabelText("Даты и последнее изменение обращения")).toHaveTextContent("Обновлено: 28.10.2026, 17:11");
});
it("does not invent an unread change when the reader failed", () => {
  state.unknown = true;
  render(<QueryClientProvider client={new QueryClient()}><TaskChangesProvider projectId="board" enabled><TaskCardDates task={task}/></TaskChangesProvider></QueryClientProvider>);
  expect(screen.queryByLabelText("Непросмотренное изменение")).not.toBeInTheDocument();
});
