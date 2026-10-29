import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { RecurringTaskDialog } from "../recurring/RecurringTaskDialog";
import { RecurringTaskList } from "../recurring/RecurringTaskList";
import { TemplateDialog } from "./TemplateDialog";
import { TemplateList } from "./TemplateList";
import type { TaskType } from "../kanban/Card";

const priorities = [
  ["CRITICAL", "Срочно"], ["URGENT", "Срочно"], ["HIGH", "Срочно"],
  ["MEDIUM", "Не срочно"], ["LOW", "Не срочно"],
] as const;
const clients: QueryClient[] = [];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
function mount(element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
function mockApi(record: unknown = {}) {
  const payloads: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, options?: RequestInit) => {
    if (options?.method === "POST") payloads.push(JSON.parse(String(options.body)));
    return new Response(JSON.stringify({ success: true, data: options?.method ? {} : [record] }), { status: 200 });
  });
  return payloads;
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.unstubAllGlobals();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

describe("recurring priority options", () => {
  it.each([["URGENT", "Срочно"], ["LOW", "Не срочно"]] as const)("offers only two urgency choices and submits %s", async (value, label) => {
    // Radix scrolls the active option; jsdom has no layout implementation.
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    const payloads = mockApi();
    mount(<RecurringTaskDialog open onOpenChange={() => {}} projectId="project-1" />);
    fireEvent.change(screen.getByLabelText("Название правила *"), { target: { value: "Правило" } });
    fireEvent.change(screen.getByLabelText("Заголовок задачи *"), { target: { value: "Задача" } });
    const trigger = screen.getAllByRole("combobox")[0];
    expect(trigger).toHaveTextContent("Не срочно");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const list = await screen.findByRole("listbox");
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    for (const optionLabel of ["Срочно", "Не срочно"]) expect(within(list).getByRole("option", { name: optionLabel })).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("option", { name: label }));
    expect(trigger).toHaveTextContent(label);
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));
    await waitFor(() => expect(payloads).toHaveLength(1));
    expect(payloads[0]).toMatchObject({ priority: value, frequency: "daily", interval: 1, daysOfWeek: [], dayOfMonth: null });
    await waitFor(() => expect(trigger).toHaveTextContent("Не срочно"));
  });

  it("submits the visible nonurgent default without requiring an urgency change", async () => {
    const payloads = mockApi();
    mount(<RecurringTaskDialog open onOpenChange={() => {}} projectId="project-1" />);
    expect(screen.getAllByRole("combobox")[0]).toHaveTextContent("Не срочно");
    fireEvent.change(screen.getByLabelText("Название правила *"), { target: { value: "Правило" } });
    fireEvent.change(screen.getByLabelText("Заголовок задачи *"), { target: { value: "Задача" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));
    await waitFor(() => expect(payloads).toHaveLength(1));
    expect(payloads[0].priority).toBe("LOW");
  });
});

describe("template priority presentation preserves source values", () => {
  it.each([...priorities, ["FUTURE_PRIORITY", "Неизвестный приоритет"]] as const)("displays and submits %s", async (priority, label) => {
    const payloads = mockApi();
    const task = { id: "task-1", projectId: "project-1", title: "Задача", priority, position: 0 } as TaskType;
    mount(<TemplateDialog open onOpenChange={() => {}} task={task} />);
    expect(screen.getByText(`• Приоритет: ${label}`)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Название шаблона *"), { target: { value: "Шаблон" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать шаблон" }));
    await waitFor(() => expect(payloads).toHaveLength(1));
    expect(payloads[0].priority).toBe(priority);
  });
});

describe.each(["template", "recurring"])("%s list priority", kind => {
  it.each([...priorities, ["FUTURE_PRIORITY", "Неизвестный приоритет"]] as const)("renders %s readably", async (priority, label) => {
    mockApi({
      id: "entry", name: "Правило", templateTitle: "Задача", taskTitle: "Задача", priority,
      tags: [], checklistItems: [], createdBy: { name: "Автор", email: "author@example.invalid" },
      active: true, frequency: "daily", interval: 1, daysOfWeek: [],
      startDate: "2026-10-21T10:00:00Z", nextRunAt: "2026-10-22T10:00:00Z",
    });
    mount(kind === "template" ? <TemplateList projectId="project-1" onUseTemplate={() => {}} /> : <RecurringTaskList projectId="project-1" />);
    const badge = await screen.findByText(label);
    if (priority !== "FUTURE_PRIORITY") expect(badge).toHaveClass(`priority-${priority.toLowerCase()}`);
  });
});
