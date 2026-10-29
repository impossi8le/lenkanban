import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";
import type { View } from "react-big-calendar";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch }));

type TestEvent = { task: TaskType };
type CalendarProps = {
  date: Date;
  view: View;
  onNavigate: (date: Date) => void;
  onView: (view: View) => void;
  onSelectEvent: (event: TestEvent) => void;
  events: TestEvent[];
  components: { event: React.ComponentType<{ event: TestEvent }> };
};

vi.mock("react-big-calendar", () => ({
  dateFnsLocalizer: () => ({}),
  Calendar: ({ date, view, onNavigate, onView, onSelectEvent, events, components }: CalendarProps) => {
    const Event = components.event;
    return <div>
      <span aria-label="Вид календаря">{view}</span>
      <span aria-label="Дата календаря">{date.toISOString()}</span>
      <button onClick={() => onNavigate(new Date("2026-11-03T12:00:00Z"))}>Другая дата</button>
      <button onClick={() => onView("week")}>Неделя</button>
      <button onClick={() => onView("day")}>День</button>
      {events.map(event => <div key={event.task.id} onClick={() => onSelectEvent(event)}><Event event={event} /></div>)}
    </div>;
  },
}));

import { CalendarView } from "./CalendarView";

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); mocks.apiFetch.mockReset(); });

function media(initial = false) {
  let listener: (() => void) | undefined;
  const remove = vi.fn();
  const query = { matches: initial, addEventListener: vi.fn((_event: string, fn: () => void) => { listener = fn; }), removeEventListener: remove };
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  return { change: async (compact: boolean) => { query.matches = compact; await act(async () => listener?.()); }, remove };
}

function show(tasks?: TaskType[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  if (tasks) client.setQueryData(["tasks", "project-1"], tasks);
  const onTaskClick = vi.fn();
  const view = render(<QueryClientProvider client={client}><CalendarView projectId="project-1" onTaskClick={onTaskClick} /></QueryClientProvider>);
  return { view, onTaskClick };
}

it("keeps the shared date and independent view choices across narrow/desktop changes", async () => {
  const mq = media();
  const { view } = show([]);
  expect(screen.getByLabelText("Вид календаря")).toHaveTextContent("month");
  fireEvent.click(screen.getByRole("button", { name: "Неделя" }));
  await mq.change(true);
  expect(screen.getByLabelText("Вид календаря")).toHaveTextContent("agenda");
  fireEvent.click(screen.getByRole("button", { name: "Другая дата" }));
  fireEvent.click(screen.getByRole("button", { name: "День" }));
  await mq.change(false);
  expect(screen.getByLabelText("Вид календаря")).toHaveTextContent("week");
  expect(screen.getByLabelText("Дата календаря")).toHaveTextContent("2026-11-03T12:00:00.000Z");
  await mq.change(true);
  expect(screen.getByLabelText("Вид календаря")).toHaveTextContent("day");
  expect(screen.getByLabelText("Дата календаря")).toHaveTextContent("2026-11-03T12:00:00.000Z");
  view.unmount();
  expect(mq.remove).toHaveBeenCalledWith("change", expect.any(Function));
});

it("starts narrow screens in agenda and forwards a task from its accessible button once", () => {
  media(true);
  const task: TaskType = { id: "task-1", projectId: "project-1", title: "Длинная задача", priority: "HIGH", position: 1, deadline: new Date("2026-11-03T12:00:00Z") };
  const { onTaskClick } = show([task]);
  expect(screen.getByLabelText("Вид календаря")).toHaveTextContent("agenda");
  fireEvent.click(screen.getByRole("button", { name: "Открыть задачу: Длинная задача" }));
  expect(onTaskClick).toHaveBeenCalledTimes(1);
  expect(onTaskClick).toHaveBeenCalledWith(task);
});

it("shows loading and request failure instead of reporting an empty calendar", async () => {
  media();
  mocks.apiFetch.mockRejectedValue(new Error("synthetic unavailable"));
  show();
  expect(screen.getByRole("status")).toHaveTextContent("Загрузка календаря");
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Не удалось загрузить календарь"));
  expect(screen.queryByText("Нет задач с дедлайнами")).not.toBeInTheDocument();
});

it("explains an empty collection of deadlines while leaving calendar navigation available", () => {
  media();
  show([]);
  expect(screen.getByRole("status")).toHaveTextContent("Нет задач с дедлайнами");
  expect(screen.getByRole("button", { name: "Другая дата" })).toBeEnabled();
});
