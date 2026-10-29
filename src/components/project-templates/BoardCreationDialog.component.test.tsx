import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BoardCreationDialog } from "./BoardCreationDialog";
import ProjectsPage from "@/app/(dashboard)/projects/page";

const mocks = vi.hoisted(() => ({ push: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: "admin", globalRole: "ADMIN" } } }) }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/components/project-templates/ProjectTemplatesPanel", () => ({ ProjectTemplatesPanel: () => null }));

const clients: QueryClient[] = [];
const reply = (data: unknown, status = 200) => Response.json(data, { status });
const departments = [
  { id: "dep-it", name: "ИТ", parentId: null, archived: false },
  { id: "dep-ops", name: "Эксплуатация", parentId: null, archived: false },
];
const groups = [{ id: "grp-duty", name: "Дежурные", archived: false }];
const templates = [{ id: "builtin-project-template-tech-support", name: "Техническая поддержка", description: null }];

function mount(initialTemplateId: string | null = null) {
  const close = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}>
    <BoardCreationDialog open onOpenChange={close} initialTemplateId={initialTemplateId} />
  </QueryClientProvider>);
  return { close };
}

function mockFetch(post: (url: string, body: unknown) => Response | Promise<Response>) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "GET") {
      if (url.startsWith("/api/admin/organization/departments")) {
        const scoped = new URL(url, "http://localhost").searchParams.has("parentId");
        return reply({ success: true, data: { items: scoped ? [] : departments, nextCursor: null } });
      }
      if (url.startsWith("/api/admin/organization/groups")) return reply({ success: true, data: { items: groups, nextCursor: null } });
      if (url === "/api/project-templates") return reply({ success: true, data: templates });
      if (url === "/api/projects") return reply({ success: true, data: [] });
    }
    return post(url, init?.body ? JSON.parse(String(init.body)) : null);
  });
}
function postCalls() {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  mockFetch(() => reply({ success: true, data: { id: "board-1" } }, 201));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.unstubAllGlobals();
});

describe("board creation scenario", () => {
  it("requires an owner department before enabling creation", async () => {
    mount();
    await screen.findByRole("option", { name: "ИТ" });
    expect(screen.getByLabelText("Подразделение доски")).toBeRequired();
    expect(screen.getByRole("button", { name: "Создать доску" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "Создать доску" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Выберите подразделение доски");
    expect(postCalls()).toHaveLength(0);
  });
  it("routes the primary projects-page button through the common dialog before any POST", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    clients.push(client);
    render(<QueryClientProvider client={client}><ProjectsPage /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Новый проект" }));
    await screen.findByRole("dialog", { name: "Создать доску" });
    expect(postCalls()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Название доски"), { target: { value: "Доска подразделения" } });
    await screen.findByRole("option", { name: "ИТ" });
    fireEvent.change(screen.getByLabelText("Подразделение доски"), { target: { value: "dep-it" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать доску" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/projects/board-1/board"));
    expect(postCalls()).toHaveLength(1);
    expect(JSON.parse(String(postCalls()[0][1]?.body))).toMatchObject({
      projectName: "Доска подразделения",
      accessProfile: { allEmployees: true, userIds: [], departmentIds: [], groupIds: [] },
    });
  });

  it("previews and submits the active profile after switching away from selected departments", async () => {
    mount();
    await screen.findByRole("option", { name: "ИТ" });
    fireEvent.change(screen.getByLabelText("Название доски"), { target: { value: "Доска" } });
    fireEvent.click(screen.getByRole("radio", { name: "Сотрудники выбранных подразделений" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Подразделение ИТ" }));
    expect(screen.getByTestId("access-preview")).toHaveTextContent("ИТ");
    fireEvent.click(screen.getByRole("radio", { name: "Никто (настроить позже)" }));
    expect(screen.getByTestId("access-preview")).toHaveTextContent("Никто: подача заявок запрещена профилем.");
    expect(screen.getByText(/он не открывает чужие заявки/)).toBeInTheDocument();
    await screen.findByRole("option", { name: "ИТ" });
    fireEvent.change(screen.getByLabelText("Подразделение доски"), { target: { value: "dep-it" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать доску" }));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(JSON.parse(String(postCalls()[0][1]?.body)).accessProfile).toEqual({
      allEmployees: false, userIds: [], departmentIds: [], groupIds: [],
    });
  });

  it("shows the agreed steps in order and a preview before confirmation", async () => {
    mount();
    await screen.findByRole("option", { name: "ИТ" });
    const text = document.body.textContent ?? "";
    const order = ["1. Подразделение", "2. Название", "3. Основа доски", "4. Профиль доступа", "Кто получит доступ"];
    const positions = order.map(label => text.indexOf(label));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(screen.getByTestId("access-preview")).toHaveTextContent("Все сотрудники организации.");
    expect(postCalls()).toHaveLength(0);
  });

  it("creates the support board in the selected department with the previewed profile", async () => {
    const { close } = mount();
    await screen.findByRole("option", { name: "ИТ" });
    fireEvent.change(screen.getByLabelText("Подразделение доски"), { target: { value: "dep-it" } });
    fireEvent.change(screen.getByLabelText("Название доски"), { target: { value: "ИТ-поддержка" } });
    fireEvent.click(screen.getByRole("radio", { name: "Сотрудники выбранных подразделений" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Подразделение Эксплуатация" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Подразделение ИТ" }));
    expect(screen.getByTestId("access-preview")).toHaveTextContent("ИТ, Эксплуатация");
    await screen.findByRole("option", { name: "ИТ" });
    fireEvent.change(screen.getByLabelText("Подразделение доски"), { target: { value: "dep-it" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать доску" }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0][0]).toBe("/api/project-templates/builtin-project-template-tech-support/use");
    expect(postCalls()[0][1] && JSON.parse(String(postCalls()[0][1]?.body))).toEqual({
      projectName: "ИТ-поддержка",
      projectDescription: null,
      departmentId: "dep-it",
      accessProfile: { allEmployees: false, userIds: [], departmentIds: ["dep-it", "dep-ops"], groupIds: [] },
    });
    expect(mocks.push).toHaveBeenCalledWith("/projects/board-1/board");
  });

  it("creates from the selected template through the template endpoint", async () => {
    const { close } = mount("builtin-project-template-tech-support");
    expect(screen.queryByLabelText("Шаблон")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Название доски"), { target: { value: "Новая доска" } });
    fireEvent.click(screen.getByRole("radio", { name: "Участники выбранных групп" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Группа Дежурные" }));
    expect(screen.getByTestId("access-preview")).toHaveTextContent("Дежурные");
    await screen.findByRole("option", { name: "ИТ" });
    fireEvent.change(screen.getByLabelText("Подразделение доски"), { target: { value: "dep-it" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать доску" }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(postCalls()[0][0]).toBe("/api/project-templates/builtin-project-template-tech-support/use");
    expect(JSON.parse(String(postCalls()[0][1]?.body))).toEqual({
      projectName: "Новая доска",
      projectDescription: null,
      departmentId: "dep-it",
      accessProfile: { allEmployees: false, userIds: [], departmentIds: [], groupIds: ["grp-duty"] },
    });
  });

  it("requires a subject before submitting a narrowed profile", async () => {
    mount();
    await screen.findByRole("option", { name: "ИТ" });
    fireEvent.change(screen.getByLabelText("Название доски"), { target: { value: "Доска" } });
    fireEvent.click(screen.getByRole("radio", { name: "Сотрудники выбранных подразделений" }));
    await screen.findByRole("option", { name: "ИТ" });
    fireEvent.change(screen.getByLabelText("Подразделение доски"), { target: { value: "dep-it" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать доску" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Выберите хотя бы одно подразделение");
    expect(postCalls()).toHaveLength(0);
  });

  it("keeps the form open and the entered data after a failure", async () => {
    mockFetch(() => reply({ success: false, error: { message: "Создание недоступно" } }, 500));
    const { close } = mount();
    await screen.findByRole("option", { name: "ИТ" });
    fireEvent.change(screen.getByLabelText("Название доски"), { target: { value: "Доска" } });
    await screen.findByRole("option", { name: "ИТ" });
    fireEvent.change(screen.getByLabelText("Подразделение доски"), { target: { value: "dep-it" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать доску" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Создание недоступно");
    expect(screen.getByLabelText("Название доски")).toHaveValue("Доска");
    expect(close).not.toHaveBeenCalled();
    expect(postCalls()).toHaveLength(1);
  });

  it("blocks dismissal and input while the board is being created", async () => {
    mockFetch(() => new Promise<Response>(() => {}));
    const { close } = mount();
    await screen.findByRole("option", { name: "ИТ" });
    fireEvent.change(screen.getByLabelText("Название доски"), { target: { value: "Доска" } });
    await screen.findByRole("option", { name: "ИТ" });
    fireEvent.change(screen.getByLabelText("Подразделение доски"), { target: { value: "dep-it" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать доску" }));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(screen.getByLabelText("Название доски")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await act(async () => {});
    expect(close).not.toHaveBeenCalled();
  });
});
