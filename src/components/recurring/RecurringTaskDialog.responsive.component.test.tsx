import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { RecurringTaskDialog } from "./RecurringTaskDialog";

const { apiFetch, toast } = vi.hoisted(() => ({ apiFetch: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const clients: QueryClient[] = [];
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
function mount() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  clients.push(client);
  const onOpenChange = vi.fn();
  const view = render(<QueryClientProvider client={client}><RecurringTaskDialog open onOpenChange={onOpenChange} projectId="project-test" /></QueryClientProvider>);
  return { ...view, onOpenChange };
}

async function selectFrequency(name: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Частота" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name }));
}

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText("Название правила *"), { target: { value: "Еженедельная проверка" } });
  fireEvent.change(screen.getByLabelText("Заголовок задачи *"), { target: { value: "Проверить оборудование" } });
}

beforeEach(() => {
  // jsdom has no layout/scrolling API; the actual Radix select still handles selection.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  apiFetch.mockReset();
  toast.mockReset();
  apiFetch.mockResolvedValue({ id: "rule-test" });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  if (scrollIntoViewDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

describe("recurring dialog schedule workflow", () => {
  it("returns keyboard focus to the actual opener when Escape closes the controlled dialog", async () => {
    function ControlledDialog() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Открыть повторение</button><RecurringTaskDialog open={open} onOpenChange={setOpen} projectId="project-test" /></>;
    }
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    clients.push(client);
    render(<QueryClientProvider client={client}><ControlledDialog /></QueryClientProvider>);
    const opener = screen.getByRole("button", { name: "Открыть повторение" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("preserves selected weekdays, dates and entered text across frequency changes and sends the existing payload", async () => {
    const { onOpenChange } = mount();
    expect(screen.getByRole("combobox", { name: "Приоритет" })).toHaveTextContent("Не срочно");
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText("Описание правила"), { target: { value: "Регулярная проверка" } });
    fireEvent.change(screen.getByLabelText("Описание задачи"), { target: { value: "Проверить по инструкции" } });
    fireEvent.change(screen.getByLabelText("Интервал"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Дата начала *"), { target: { value: "2026-11-02" } });
    fireEvent.change(screen.getByLabelText("Дата окончания"), { target: { value: "2026-12-28" } });
    await selectFrequency("Еженедельно");
    fireEvent.click(screen.getByRole("checkbox", { name: "Пн" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Пт" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Ср" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Ср" }));
    await selectFrequency("Ежемесячно");
    fireEvent.change(screen.getByLabelText("День месяца"), { target: { value: "15" } });
    await selectFrequency("Еженедельно");
    expect(screen.getByRole("checkbox", { name: "Пн" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Пт" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Ср" })).not.toBeChecked();
    expect(screen.getByLabelText("Дата начала *")).toHaveValue("2026-11-02");
    expect(screen.getByLabelText("Дата окончания")).toHaveValue("2026-12-28");
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const [url, options] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/recurring-tasks");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({
      projectId: "project-test", name: "Еженедельная проверка", description: "Регулярная проверка",
      taskTitle: "Проверить оборудование", taskDescription: "Проверить по инструкции", priority: "LOW",
      frequency: "weekly", interval: 2, daysOfWeek: [1, 5], dayOfMonth: null,
      startDate: "2026-11-02", endDate: "2026-12-28", tags: [], checklistItems: [], assigneeIds: [],
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("keeps the schedule and dialog available after a failed save so the user can retry", async () => {
    apiFetch.mockRejectedValueOnce(new Error("Synthetic failure"));
    const { onOpenChange } = mount();
    fillRequiredFields();
    await selectFrequency("Еженедельно");
    fireEvent.click(screen.getByRole("checkbox", { name: "Сб" }));
    fireEvent.change(screen.getByLabelText("Дата начала *"), { target: { value: "2026-11-07" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Сб" })).toBeChecked();
    expect(screen.getByLabelText("Дата начала *")).toHaveValue("2026-11-07");
    expect(screen.getByLabelText("Название правила *")).toHaveValue("Еженедельная проверка");
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[1]).toEqual(apiFetch.mock.calls[0]);
  });
});
