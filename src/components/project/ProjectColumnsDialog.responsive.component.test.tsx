import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectColumnsDialog } from "./ProjectColumnsDialog";

const { apiFetch, apiPost, apiPatch, apiDelete, toast } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ apiFetch, apiPost, apiPatch, apiDelete }));
vi.mock("sonner", () => ({ toast }));

const columns = [
  { id: "col-1", projectId: "p-1", name: "Входящие", color: "#3b82f6", position: 0 },
  { id: "col-2", projectId: "p-1", name: "В работе", color: "#10b981", position: 1 },
];

const clients: QueryClient[] = [];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ProjectColumnsDialog projectId="p-1" open onOpenChange={onOpenChange} />
    </QueryClientProvider>
  );
  return { onOpenChange };
}

beforeEach(() => {
  apiFetch.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiDelete.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  apiFetch.mockResolvedValue(columns);
  apiPost.mockResolvedValue({ id: "col-new", projectId: "p-1", name: "Тест", color: "#3b82f6", position: 2 });
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.unstubAllGlobals();
});

describe("ProjectColumnsDialog responsive workflows", () => {
  it.each([403, 503])("keeps recovery visible and permits exit after rejected PUT403 then GET%d", async readStatus => {
    const five = ["new", "work", "wait", "resolved", "closed"].map((id, position) => ({ id, projectId: "p-1", name: `Column ${id}`, color: "#123456", position }));
    let reads = 0;
    apiFetch.mockImplementation((path: string, options?: RequestInit) => {
      if (options?.method === "PUT") return Promise.reject(Object.assign(new Error("Rejected"), { status: 403 }));
      if (path.includes("?lifecycle=1")) return ++reads === 1 ? Promise.resolve({ version: 0, lifecycleColumnMap: null }) : Promise.reject(Object.assign(new Error("Read failed"), { status: readStatus }));
      return Promise.resolve(five);
    });
    const { onOpenChange } = mount();
    for (const [index, label] of ["Новая", "В работе", "Ожидает ответа", "Решена", "Закрыта"].entries()) {
      fireEvent.change(await screen.findByRole("combobox", { name: label }), { target: { value: five[index].id } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Сохранить маршрут" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить маршрут" }));
    expect(await screen.findByText(/Не удалось загрузить актуальный маршрут/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Загрузить маршрут" })).toBeEnabled();
    const close = screen.getAllByRole("button", { name: "Закрыть" }).find(button => !button.hasAttribute("disabled"))!;
    fireEvent.click(close); expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it("renders with viewport-bounded scrolling dialog container and wrapped columns", async () => {
    const { onOpenChange } = mount();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-y-auto");
    expect(await screen.findByText("Входящие")).toBeInTheDocument();
    expect(screen.getByText("В работе")).toBeInTheDocument();

    const closeBtns = screen.getAllByRole("button", { name: "Закрыть" });
    expect(closeBtns.length).toBeGreaterThan(0);
    fireEvent.click(closeBtns[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens inline editor and renders wrapped responsive edit controls", async () => {
    mount();
    await screen.findByText("Входящие");
    const editBtns = screen.getAllByRole("button", { name: "Изменить" });
    fireEvent.click(editBtns[0]);

    const input = screen.getByPlaceholderText("Название колонки");
    expect(input).toHaveValue("Входящие");
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeInTheDocument();
  });

  it("supports adding a new column with accessible mobile layout", async () => {
    mount();
    await screen.findByText("Входящие");
    const addBtn = screen.getByRole("button", { name: "Добавить колонку" });
    fireEvent.click(addBtn);

    const input = screen.getByPlaceholderText("Название новой колонки");
    fireEvent.change(input, { target: { value: "Тестовая колонка" } });
    const createBtn = screen.getByRole("button", { name: "Создать" });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith("/api/projects/p-1/columns", {
        name: "Тестовая колонка",
        color: "#3b82f6",
      });
    });
  });
});
