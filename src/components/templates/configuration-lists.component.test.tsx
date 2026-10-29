import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplateList } from "./TemplateList";
import { RecurringTaskList } from "../recurring/RecurringTaskList";
import { AutomationRuleList } from "../automation/AutomationRuleList";

const record = {
  id: "entry-1", name: "Проверка", description: null, templateTitle: "Задача",
  templateDescription: null, priority: "CRITICAL", tags: [], checklistItems: [],
  createdBy: { id: "user-1", name: "Автор", email: "test@example.invalid" },
  createdAt: "2026-09-14T10:00:00Z", taskTitle: "Задача", taskDescription: null,
  frequency: "daily", interval: 1, daysOfWeek: [], dayOfMonth: null,
  startDate: "2026-09-14T10:00:00Z", endDate: null, nextRunAt: "2026-09-15T10:00:00Z",
  active: true, lastRunAt: null, trigger: "task_created", conditions: [], actions: [],
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe.each([
  { name: "template", element: <TemplateList projectId="project-1" onUseTemplate={() => {}} /> },
  { name: "recurring", element: <RecurringTaskList projectId="project-1" /> },
  { name: "automation", element: <AutomationRuleList projectId="project-1" /> },
])("$name configuration actions", ({ name, element }) => {
  it("only sends deletion after explicit confirmation", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, options?: RequestInit) => {
      if (options?.method === "DELETE") requests.push("DELETE");
      return new Response(JSON.stringify({ success: true, data: options?.method ? {} : [record] }), { status: 200 });
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
    const button = await screen.findByRole("button", { name: /Удалить/ });
    fireEvent.click(button);
    expect(requests).toEqual([]);
    expect(confirm).toHaveBeenCalledOnce();
    confirm.mockReturnValue(true);
    fireEvent.click(button);
    await waitFor(() => expect(requests).toEqual(["DELETE"]));
    if (name !== "automation") expect(screen.getByText("Срочно")).toBeInTheDocument();
    if (name !== "template") expect(screen.getByRole("switch", { name: /Проверка/ })).toBeInTheDocument();
    client.clear();
  });
});
