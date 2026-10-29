import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateTaskDialog } from "./CreateTaskDialog";
import { TaskForm } from "./TaskForm";

const mocks = vi.hoisted(() => ({ post: vi.fn(), upload: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiPost: mocks.post, apiFetch: (url: string, options: RequestInit) => url.endsWith("/lifecycle") ? Promise.resolve({ state: null, version: 0, marked: false }) : mocks.upload(url, options) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: "attachment-actor" } } }) }));
vi.mock("next/navigation", () => ({useRouter: () => ({push: vi.fn()})}));

afterEach(() => { cleanup(); mocks.post.mockReset(); mocks.upload.mockReset(); });

describe.each(["form", "dialog"] as const)("pending attachments in %s", variant => {
  const titleLabel = variant === "dialog" ? "Кратко о проблеме" : "Название";
  const submitLabel = variant === "dialog" ? "Отправить обращение" : "Создать задачу";
  function mount() {
    const close = vi.fn();
    const client = new QueryClient();
    render(<QueryClientProvider client={client}>
      {variant === "dialog"
        ? <CreateTaskDialog projectId="board" canCreate open onClose={close} />
        : <TaskForm projectId="board" onSubmit={data => mocks.post("/api/tasks", data)} />}
    </QueryClientProvider>);
    fireEvent.change(screen.getByLabelText(titleLabel), { target: { value: "Synthetic request" } });
    return { close };
  }

  function selectFile() {
    const file = new File(["synthetic"], "report.pdf", { type: "application/pdf" });
    expect(screen.getByRole("button", { name: "Выбрать файлы" })).toBeEnabled();
    expect(screen.getByLabelText("Файлы для вложения")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Файлы для вложения"), { target: { files: [file] } });
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(mocks.upload).not.toHaveBeenCalled();
    return file;
  }

  it("creates first, binds files to the returned id and recovers without duplicating creation", async () => {
    mocks.post.mockResolvedValue({ id: "created-task" });
    mocks.upload.mockRejectedValueOnce(Object.assign(new Error("Unavailable"), { status: 503 }))
      .mockResolvedValueOnce({ uploaded: [{ url: "/api/tasks/created-task/files/report.pdf", name: "report.pdf", mime: "application/pdf", size: 9 }], count: 1 });
    const { close } = mount();
    const file = selectFile();
    fireEvent.click(screen.getByRole("button", { name: submitLabel }));
    expect(await screen.findByRole("alert")).toHaveTextContent(variant === "dialog" ? "загрузка файлов сейчас недоступна на сервере" : "Задача создана");
    if (variant === "dialog") expect(screen.getByRole("note")).toHaveTextContent("загрузка файлов не подтверждена");
    expect(close).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/tasks", variant === "dialog" ? expect.objectContaining({
      projectId: "board", title: "Synthetic request", description: "", priority: "LOW", operationId: expect.any(String),
    }) : {
      projectId: "board", title: "Synthetic request", description: "",
    });
    const [url, options] = mocks.upload.mock.calls[0];
    expect(url).toBe("/api/uploads/direct");
    expect(options.method).toBe("POST");
    expect(options.body.get("taskId")).toBe("created-task");
    expect(options.body.getAll("files")).toEqual([file]);
    expect(screen.getByLabelText(titleLabel)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: variant === "dialog" ? "Продолжить без подтверждённых файлов" : "Повторить загрузку вложений" }));
    await waitFor(() => {
      if (variant === "dialog") expect(close).toHaveBeenCalledOnce();
      else expect(screen.getByRole("status")).toHaveTextContent("Вложения прикреплены");
    });
    expect(mocks.post.mock.calls.filter(([url]) => url === "/api/tasks")).toHaveLength(1);
    expect(mocks.upload).toHaveBeenCalledTimes(variant === "dialog" ? 1 : 2);
    if (variant === "dialog") expect(mocks.post.mock.calls[1]).toEqual(["/api/tasks/created-task", expect.objectContaining({ action: "submit", expectedVersion: 0 })]);
  });

  it("prevents duplicate creation when the response has no id for binding", async () => {
    mocks.post.mockResolvedValue({});
    mount();
    selectFile();
    fireEvent.click(screen.getByRole("button", { name: submitLabel }));
    expect(await screen.findByRole("alert")).toHaveTextContent(variant === "dialog" ? "Не удалось подтвердить отправку" : "идентификатор не получен");
    if (variant === "dialog") {
      expect(screen.getByLabelText(titleLabel)).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" }));
      await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
      expect(mocks.post.mock.calls[1]).toEqual(mocks.post.mock.calls[0]);
    } else {
      expect(screen.getByRole("button", { name: "Задача создана" })).toBeDisabled();
      fireEvent.submit(screen.getByLabelText(titleLabel).closest("form")!);
      expect(mocks.post).toHaveBeenCalledOnce();
    }
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
