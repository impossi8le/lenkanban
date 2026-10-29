import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RequestActionsContext } from "@/components/task/RequestQuickTake";
import { KanbanCardView } from "./Card";

afterEach(cleanup);

it("renders creation in Russian Moscow time without inventing a work update or exposing technical identifiers", () => {
  const createdAt = "2026-10-28T10:00:00.000Z";
  render(<KanbanCardView task={{ id: "task", title: "Задача", projectId: "project", priority: "MEDIUM", position: 1024, createdAt }} />);
  expect(screen.getByLabelText("Создание обращения, московское время")).toHaveTextContent("Создано: 28.10.2026, 13:00");
  expect(screen.getByText("28.10.2026, 13:00")).toHaveAttribute("dateTime", createdAt);
  expect(screen.queryByLabelText("Последнее обновление, московское время")).not.toBeInTheDocument();
  expect(screen.queryByText(/#task/)).not.toBeInTheDocument();
});

it("opens canonical request actions for executors without moving the card locally", () => {
  const onOpen = vi.fn();
  const task = { id: "task", title: "Задача", projectId: "project", priority: "MEDIUM", position: 1024, request: { state: "IN_PROGRESS", executorId: "actor" } };
  const view = render(<RequestActionsContext.Provider value={false}><KanbanCardView task={task} onOpen={onOpen} /></RequestActionsContext.Provider>);
  expect(screen.queryByRole("button", { name: "Открыть обращение →" })).not.toBeInTheDocument();
  view.rerender(<RequestActionsContext.Provider value><KanbanCardView task={task} onOpen={onOpen} /></RequestActionsContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Открыть обращение →" }));
  expect(onOpen).toHaveBeenCalledOnce();
  expect(onOpen.mock.calls[0][0]).toBeInstanceOf(HTMLButtonElement);
});

it.each([["NEEDS_INFO", "Нужен ответ автора обращения"], ["COMPLETED", "Специалист отметил как решённое"]])("shows the real %s stage instead of waiting for a specialist", (state, label) => {
  render(<KanbanCardView task={{ id: "task", title: "Задача", projectId: "project", priority: "MEDIUM", position: 1024, request: { state, executorId: null } }} />);
  expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.queryByText("⌛ Ждёт специалиста")).not.toBeInTheDocument();
});
