import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectTemplateList } from "./ProjectTemplateList";
import { ProjectTemplatesPanel } from "./ProjectTemplatesPanel";
import { UseTemplateDialog } from "./UseTemplateDialog";
import { ProjectTemplateDialog } from "./ProjectTemplateDialog";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const template = { id: "builtin-project-template-tech-support", name: "Техническая поддержка", description: null, templateData: { columns: [{}], tags: [] }, createdAt: "2026-09-14", createdBy: { id: "u1", name: "Павел", email: "test@example.invalid" } };

function mount(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** The creation dialog reads departments, groups and templates before submit. */
function mockCreationLookups(post: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/admin/organization/departments")) {
      return reply({ success: true, data: { items: [{ id: "dep-1", name: "ИТ", parentId: null, archived: false }], nextCursor: null } });
    }
    if (url.startsWith("/api/admin/organization/groups")) {
      return reply({ success: true, data: { items: [{ id: "grp-1", name: "Дежурные", archived: false }], nextCursor: null } });
    }
    if (url === "/api/project-templates" && (init?.method ?? "GET") === "GET") {
      return reply({ success: true, data: [template] });
    }
    return post(url, init);
  });
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("project template API integration", () => {
  it("renders the template array inside the standard success envelope", async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ success: true, data: [template] }));
    const useTemplate = vi.fn();
    mount(<ProjectTemplateList onUseTemplate={useTemplate} />);
    expect(await screen.findByText("Техническая поддержка")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Использовать" }));
    expect(useTemplate).toHaveBeenCalledWith("builtin-project-template-tech-support");
  });

  it("marks only explicitly shared templates as organization-wide", async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ success: true, data: [
      { ...template, templateData: { columns: [], tags: [], availability: "organization" } },
      { ...template, id: "tpl-2", name: "Личный" },
    ] }));
    mount(<ProjectTemplateList onUseTemplate={vi.fn()} />);
    expect(await screen.findByText("Доступен организации")).toBeInTheDocument();
    expect(screen.getAllByText("Доступен организации")).toHaveLength(1);
  });

  it("shows failed loading as an error with retry, not an empty library", async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ success: false, error: { message: "Нет доступа" } }, 403));
    mount(<ProjectTemplateList onUseTemplate={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Нет доступа");
    expect(screen.getByRole("button", { name: "Повторить" })).toBeInTheDocument();
    expect(screen.queryByText("Нет шаблонов проектов")).not.toBeInTheDocument();
  });

  it("navigates to the created project ID from the response envelope", async () => {
    mockCreationLookups(() => reply({ success: true, data: { id: "project-new" } }, 201));
    mount(<UseTemplateDialog open onOpenChange={vi.fn()} templateId="builtin-project-template-tech-support" />);
    fireEvent.change(screen.getByLabelText("Название доски"), { target: { value: "Новый" } });
    await screen.findByRole("option", { name: "ИТ" });
    fireEvent.change(screen.getByLabelText("Подразделение доски"), { target: { value: "dep-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать доску" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects/project-new/board"));
    const posted = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST");
    expect(posted?.[0]).toBe("/api/project-templates/builtin-project-template-tech-support/use");
  });

  it("opens the shared creation scenario with the chosen template preselected", async () => {
    mockCreationLookups(() => reply({ success: true, data: { id: "board-1" } }, 201));
    mount(<ProjectTemplatesPanel open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Использовать" }));
    expect(await screen.findByRole("heading", { name: "Создать доску" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Шаблон")).not.toBeInTheDocument();
    expect(screen.getByTestId("access-preview")).toBeInTheDocument();
  });

  it("offers only support and does not allow deleting the built-in preset", async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ success: true, data: [template, { ...template, id: "retired", name: "Старый процесс" }] }));
    mount(<ProjectTemplateList onUseTemplate={vi.fn()} />);
    expect(await screen.findByText("Техническая поддержка")).toBeInTheDocument();
    expect(screen.queryByText("Старый процесс")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Использовать" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Удалить/ })).not.toBeInTheDocument();
  });

  it("keeps a failed save open and displays the server error", async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ success: false, error: { message: "Сохранение недоступно" } }, 500));
    const close = vi.fn();
    mount(<ProjectTemplateDialog open onOpenChange={close} projectId="p1" projectName="Проект" />);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить шаблон" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Сохранение недоступно");
    expect(close).not.toHaveBeenCalled();
  });
});
