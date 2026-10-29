import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UseTemplateDialog } from "./UseTemplateDialog";
import { ProjectTemplateDialog } from "./ProjectTemplateDialog";

const mocks = vi.hoisted(() => ({ push: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));

const clients: QueryClient[] = [];
const reply = (data: unknown, status = 200) => Response.json(data, { status });
const success = () => reply({ success: true, data: { id: "server-project-id" } }, 201);
const emptyPage = () => reply({ success: true, data: { items: [], nextCursor: null } });
const emptyTemplates = () => reply({ success: true, data: [] });
const cases = [
  { kind: "apply", label: "Название доски", submit: "Создать доску", endpoint: "/api/project-templates/builtin-project-template-tech-support/use", query: "projects" },
  { kind: "save", label: "Название шаблона", submit: "Сохранить шаблон", endpoint: "/api/project-templates", query: "project-templates" },
] as const;
type DialogCase = typeof cases[number];

/** The creation dialog loads bounded department/group/template lists first. */
function isLookup(url: string, init?: RequestInit) {
  return (init?.method ?? "GET") === "GET" && (
    url.startsWith("/api/admin/organization/departments")
    || url.startsWith("/api/admin/organization/groups")
    || url === "/api/project-templates"
  );
}
function lookup(url: string) {
  if (url.startsWith("/api/admin/organization/departments")) {
    return reply({ success: true, data: { items: [{ id: "department", name: "ИТ", parentId: null, archived: false }], nextCursor: null } });
  }
  return url === "/api/project-templates" ? emptyTemplates() : emptyPage();
}
function postCalls() {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
}

function mount(item: DialogCase, projectName = "Исходный проект") {
  const close = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: 1, retryDelay: 0 } } });
  clients.push(client);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}>{item.kind === "apply"
    ? <UseTemplateDialog open onOpenChange={close} templateId="template-prop" />
    : <ProjectTemplateDialog open onOpenChange={close} projectId="project-prop" projectName={projectName} />}</QueryClientProvider>);
  return { close, invalidate };
}

async function fields(item: DialogCase, name = "  Новый проект  ", description = "  Описание  ") {
  if (item.kind === "apply") {
    await screen.findByRole("option", { name: "ИТ" });
    fireEvent.change(screen.getByLabelText("Подразделение доски"), { target: { value: "department" } });
  }
  fireEvent.change(screen.getByLabelText(item.label), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Описание"), { target: { value: description } });
}
function form(item: DialogCase) {
  const result = screen.getByLabelText(item.label).closest("form");
  if (!result) throw new Error("Dialog form is missing");
  return result;
}
function payload(item: DialogCase) {
  return item.kind === "apply"
    ? {
      projectName: "Новый проект", projectDescription: "Описание", departmentId: "department",
      accessProfile: { allEmployees: true, userIds: [], departmentIds: [], groupIds: [] },
    }
    : { name: "Новый проект", description: "Описание", projectId: "project-prop", availability: "creator" };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: string | URL | Request, init?: RequestInit) =>
    isLookup(String(input), init) ? lookup(String(input)) : success()));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.unstubAllGlobals();
});

describe.each(cases)("$kind project template dialog submit", (item) => {
  it("admits only one synchronous submit before React rerenders", async () => {
    vi.mocked(fetch).mockImplementation((input: string | URL | Request, init?: RequestInit) => isLookup(String(input), init)
      ? Promise.resolve(lookup(String(input)))
      : new Promise<Response>(() => {}));
    mount(item);
    await fields(item);
    await act(async () => {
      fireEvent.submit(form(item));
      fireEvent.submit(form(item));
    });
    await waitFor(() => expect(postCalls()).toHaveLength(1));
  });

  it("disables editable fields and cancel while the request is pending", async () => {
    vi.mocked(fetch).mockImplementation((input: string | URL | Request, init?: RequestInit) => isLookup(String(input), init)
      ? Promise.resolve(lookup(String(input)))
      : new Promise<Response>(() => {}));
    const { close } = mount(item);
    await fields(item);
    fireEvent.submit(form(item));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(screen.getByLabelText(item.label)).toBeDisabled();
    expect(screen.getByLabelText("Описание")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeDisabled();
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["escape", "close", "outside"])("ignores %s dismissal while a request is pending", async (way) => {
    vi.mocked(fetch).mockImplementation((input: string | URL | Request, init?: RequestInit) => isLookup(String(input), init)
      ? Promise.resolve(lookup(String(input)))
      : new Promise<Response>(() => {}));
    const { close } = mount(item);
    await fields(item);
    fireEvent.submit(form(item));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    if (way === "escape") fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    if (way === "close") fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    if (way === "outside") fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse", isPrimary: true });
    await act(async () => {});
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("disables automatic mutation retries even when QueryClient defaults retry once", async () => {
    vi.mocked(fetch).mockImplementation(async (input: string | URL | Request, init?: RequestInit) => isLookup(String(input), init)
      ? lookup(String(input))
      : reply({ success: false, error: { message: "Сервис недоступен" } }, 500));
    const { close } = mount(item);
    await fields(item);
    fireEvent.submit(form(item));
    expect(await screen.findByRole("alert")).toHaveTextContent("Сервис недоступен");
    expect(postCalls()).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
  });

  it.each([500, 429])("preserves input after HTTP %s and retries manually with the same normalized fields", async (status) => {
    vi.mocked(fetch).mockImplementation(async (input: string | URL | Request, init?: RequestInit) => isLookup(String(input), init)
      ? lookup(String(input))
      : status === 429
        ? reply({ error: "RateLimited", retryAfter: 17 }, 429)
        : reply({ success: false, error: { message: "Сервис недоступен" } }, 500));
    const { close } = mount(item);
    await fields(item);
    fireEvent.submit(form(item));
    const alert = await screen.findByRole("alert");
    if (status === 429) expect(alert).toHaveTextContent(/позже|часто|запрос/i);
    else expect(alert).toHaveTextContent("Сервис недоступен");
    expect(screen.getByLabelText(item.label)).toHaveValue("  Новый проект  ");
    expect(screen.getByLabelText("Описание")).toHaveValue("  Описание  ");
    expect(close).not.toHaveBeenCalled();
    expect(postCalls()).toHaveLength(1);
    expect(JSON.parse(String(postCalls()[0][1]?.body))).toEqual(payload(item));
    vi.mocked(fetch).mockImplementation(async (input: string | URL | Request, init?: RequestInit) => isLookup(String(input), init)
      ? lookup(String(input))
      : success());
    fireEvent.click(screen.getByRole("button", { name: item.submit }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(postCalls()).toHaveLength(2);
    expect(JSON.parse(String(postCalls()[1][1]?.body))).toEqual(payload(item));
  });

  it.each([
    { field: "name", value: "x".repeat(121) },
    { field: "description", value: "x".repeat(10_001) },
    { field: "name", value: "   " },
  ].map((value, index) => ({ ...value, index })))("does not POST invalid client field case $index", async ({ field, value }) => {
    mount(item);
    await fields(item, field === "name" ? value : "Новый проект", field === "description" ? value : "Описание");
    await act(async () => { fireEvent.submit(form(item)); });
    expect(postCalls()).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("accepts exact field limits and uses prop identity and the returned project id", async () => {
    const { close, invalidate } = mount(item);
    const name = "x".repeat(120), description = "x".repeat(10_000);
    await fields(item, name, description);
    fireEvent.submit(form(item));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0][0]).toBe(item.endpoint);
    expect(JSON.parse(String(postCalls()[0][1]?.body))).toEqual(item.kind === "apply"
      ? { ...payload(item), projectName: name, projectDescription: description }
      : { name, description, projectId: "project-prop", availability: "creator" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [item.query] });
    if (item.kind === "apply") expect(mocks.push).toHaveBeenCalledWith("/projects/server-project-id/board");
    else expect(mocks.push).not.toHaveBeenCalled();
  });

  it("normalizes accepted fields and completes one valid request", async () => {
    const { close, invalidate } = mount(item);
    await fields(item);
    fireEvent.submit(form(item));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0][0]).toBe(item.endpoint);
    expect(JSON.parse(String(postCalls()[0][1]?.body))).toEqual(payload(item));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [item.query] });
  });
});

it("bounds the generated template name including its suffix to 120 characters", () => {
  mount(cases[1], "x".repeat(120));
  const value = (screen.getByLabelText("Название шаблона") as HTMLInputElement).value;
  expect(value.length).toBeLessThanOrEqual(120);
  expect(value).toMatch(/шаблон$/);
});
