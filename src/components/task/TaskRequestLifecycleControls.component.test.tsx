import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskLifecycleSnapshot } from "./TaskRequestLifecycleControls";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  remove: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api", () => ({
  apiFetch: mocks.get,
  apiPost: mocks.post,
  apiDelete: mocks.remove,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { TaskRequestLifecycleControls } from "./TaskRequestLifecycleControls";

const base: TaskLifecycleSnapshot = {
  taskId: "task",
  projectId: "project",
  version: 7,
  marked: true,
  deleted: false,
  state: "DRAFT",
  authorId: "author",
  executorId: null,
  executorName: null,
  permissions: {
    isAuthor: true,
    isExecutor: false,
    isLeader: false,
    isGroupMember: false,
    canParticipate: true,
    canExecute: false,
    canAssign: false,
  },
  assignees: null,
  attachments: [],
};

const clients: QueryClient[] = [];

it("offers the accountant explicit invoice readiness with a retained public document, never customer closure", async () => {
  mount({ ...base, state: "IN_PROGRESS", workflowKind: "beznal", beznalPhase: "WAITING", executorId: "accountant", invoiceFiles: [{ url: "/api/tasks/task/files/invoice", name: "Готовый счёт.pdf" }],
    permissions: { ...base.permissions, isAuthor: false, isExecutor: true, canExecute: true, canMarkInvoiceReady: true } }, true, "accountant");
  fireEvent.click(await screen.findByRole("button", { name: "Перевести в «Со счётом»" }));
  expect(screen.queryByRole("button", { name: "Отметить как решённое" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Отменить обращение" })).not.toBeInTheDocument();
  expect(screen.getByText("Готовый счёт.pdf")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить: со счётом" }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/tasks/task", expect.objectContaining({ action: "mark_invoice_ready", invoiceUrl: "/api/tasks/task/files/invoice", expectedVersion: 7 })));
});
it("requires customer confirmation to approve; replays the same operation after a lost result", async () => {
  mocks.post.mockRejectedValueOnce(new Error("network"));
  mount({ ...base, state: "IN_PROGRESS", workflowKind: "beznal", beznalPhase: "INVOICED", executorId: "accountant", permissions: { ...base.permissions, canApprove: true, canReturnForRevision: true } }, true, "sales");
  fireEvent.click(await screen.findByRole("button", { name: "Принять и закрыть" }));
  expect(mocks.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить приёмку и закрыть" }));
  fireEvent.click(await screen.findByRole("button", { name: "Повторить тот же запрос" }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
  expect(mocks.post.mock.calls[1][1]).toEqual(mocks.post.mock.calls[0][1]);
  expect(mocks.post.mock.calls[0][1]).toMatchObject({ action: "approve", expectedVersion: 7 });
});
it("returns an archived invoice for customer revision with the existing required reason dialog", async () => {
  mount({ ...base, state: "CLOSED", workflowKind: "beznal", permissions: { ...base.permissions, isAuthor: false, canReturnForRevision: true } }, true, "sales");
  fireEvent.click(await screen.findByRole("button", { name: "Вернуть на доработку" }));
  expect(screen.queryByRole("button", { name: "Проблема не решена" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Закрыть решённое обращение" })).not.toBeInTheDocument();
  expect(mocks.post).not.toHaveBeenCalled();
});

it.each(["IN_PROGRESS", "NEEDS_INFO"] as const)("requires explicit confirmation before taking over %s from a colleague", async state => {
  mount({ ...base, state, executorId: "colleague", executorName: "Коллега в отпуске",
    permissions: { ...base.permissions, isAuthor: false, canExecute: true } }, true, "replacement");
  fireEvent.click(await screen.findByRole("button", { name: "Взять на себя" }));
  expect(screen.getByText(/Сейчас исполнитель: Коллега в отпуске/)).toBeVisible();
  expect(mocks.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить: взять на себя" }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/tasks/task", expect.objectContaining({ action: "take_over", expectedVersion: 7 })));
});

it.each(["COMPLETED", "CLOSED", "CANCELLED", "SUBMITTED", "DRAFT"] as const)("hides takeover for %s", async state => {
  mount({ ...base, state, executorId: "colleague", permissions: { ...base.permissions, canExecute: true } });
  await screen.findByRole("heading", { name: /Статус:/ });
  expect(screen.queryByRole("button", { name: "Взять на себя" })).toBeNull();
});

it("offers transfer after assignment and excludes the current executor from choices", async () => {
  mount({ ...base, state: "IN_PROGRESS", executorId: "current", executorName: "Текущий исполнитель",
    permissions: { ...base.permissions, isAuthor: false, isExecutor: true, canExecute: true, canAssign: true },
    assignees: [{ id: "current", name: "Текущий исполнитель", email: "current@example.invalid" }, { id: "next", name: "Другой исполнитель", email: "next@example.invalid" }] });
  fireEvent.click(await screen.findByRole("button", { name: "Передать другому исполнителю" }));
  expect(screen.getByRole("heading", { name: "Передать другому исполнителю" })).toBeInTheDocument();
  expect(screen.getByText(/Сейчас исполнитель: Текущий исполнитель/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Текущий исполнитель" })).toBeNull();
  expect(screen.getByRole("button", { name: "Передать обращение" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Другой исполнитель" }));
  expect(screen.getByRole("button", { name: "Передать обращение" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Назначить исполнителя" })).toBeNull();
});

it("hides transfer without server permission", async () => {
  mount({ ...base, state: "IN_PROGRESS", executorId: "current", permissions: { ...base.permissions, canAssign: false } });
  await screen.findByText("Статус:", { exact: false });
  expect(screen.queryByRole("button", { name: /Передать другому исполнителю|Назначить исполнителя/ })).toBeNull();
});

it("explains when no different eligible executor exists without widening confidential audience", async () => {
  mount({ ...base, state: "IN_PROGRESS", executorId: "current", permissions: { ...base.permissions, isExecutor: true, canExecute: true, canAssign: true },
    assignees: [{ id: "current", name: "Текущий исполнитель", email: "current@example.invalid" }] });
  fireEvent.click(await screen.findByRole("button", { name: "Передать другому исполнителю" }));
  expect(screen.getByText(/Других доступных исполнителей для этого обращения нет/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Передать обращение" })).toBeDisabled();
  expect(mocks.post).not.toHaveBeenCalled();
});
function mount(snapshot: TaskLifecycleSnapshot = base, compact = false, actorId?: string, boardPhase?: {code: string; label: string}) {
  mocks.get.mockImplementation(async (path: string) => path.startsWith("/api/activities?") ? [] : snapshot);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <TaskRequestLifecycleControls taskId="task" projectId="project" compact={compact} actorId={actorId} boardPhase={boardPhase}/>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.remove.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
  vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
  mocks.post.mockResolvedValue({ taskId: "task", version: 8, state: "SUBMITTED" });
  mocks.remove.mockResolvedValue({ deleted: true, logical: true });
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

describe("request lifecycle controls", () => {
  it("shows the latest question beside the fresh waiting author's answer action without blocking it", async () => {
    const waiting = { ...base, state: "NEEDS_INFO" as const };
    mount(waiting, true, "author");
    mocks.get.mockImplementation(async (path: string) => path.startsWith("/api/activities?")
      ? [{ action: "request_info_requested", newValue: { reason: "Какой номер заказа?" } }]
      : waiting);
    expect(await screen.findByText("Какой номер заказа?")).toBeVisible();
    expect(screen.getByRole("button", { name: "Ответить и вернуть в работу" })).toBeEnabled();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("does not read questions without participation or an author/executor role", async () => {
    mount({ ...base, state: "NEEDS_INFO", permissions: { ...base.permissions, isAuthor: false, canParticipate: false } }, true, "observer");
    await screen.findByText("Статус: ждём ответа автора");
    expect(screen.queryByText("Вопрос специалиста")).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledOnce();
  });

  it("keeps the canonical answer action available after the question read fails", async () => {
    const waiting = { ...base, state: "NEEDS_INFO" as const };
    mount(waiting, true, "author");
    mocks.get.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/activities?")) throw new Error("Synthetic history failure");
      return waiting;
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Ошибка загрузки вопроса");
    expect(screen.getByRole("button", { name: "Ответить и вернуть в работу" })).toBeEnabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("does not read questions from cached lifecycle permissions while the fresh snapshot is pending", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
    client.setQueryData(["task-lifecycle", "task", "author"], { ...base, state: "NEEDS_INFO" });
    const lifecycle = deferred<TaskLifecycleSnapshot>();
    mocks.get.mockReturnValue(lifecycle.promise);
    render(<QueryClientProvider client={client}><TaskRequestLifecycleControls taskId="task" projectId="project" actorId="author" compact /></QueryClientProvider>);
    expect(screen.queryByText("Вопрос специалиста")).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith("/api/tasks/task/lifecycle");
    await act(async () => lifecycle.resolve({ ...base, state: "SUBMITTED" }));
    await screen.findByText("Статус: новое обращение");
    expect(mocks.get).toHaveBeenCalledOnce();
  });

  it.each([false, true])("explains the author's submitted request and makes cancellation secondary (compact=%s)", async compact => {
    mount({ ...base, state: "SUBMITTED" }, compact);
    expect(await screen.findByRole("heading", { name: "Статус: новое обращение" })).toBeVisible();
    expect(screen.getByText("Ваше обращение отправлено в отдел. Специалист пока не назначен.")).toBeVisible();
    expect(screen.getByText(/Дождитесь ответа специалиста/)).toBeVisible();
    const cancel = screen.getByRole("button", { name: "Отменить обращение" });
    expect(cancel.parentElement?.parentElement).toHaveTextContent("Помощь больше не нужна?");
    expect(screen.queryByRole("button", { name: "Взять в работу" })).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("confirms cancellation before posting and explains the preserved history and archive", async () => {
    mount({ ...base, state: "SUBMITTED" }, true);
    fireEvent.click(await screen.findByRole("button", { name: "Отменить обращение" }));
    expect(screen.getByRole("dialog", { name: "Отменить обращение?" })).toBeVisible();
    expect(screen.getByText(/История обращения сохранится; обращение можно будет найти в архиве/)).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Не отменять обращение" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Отменить обращение" }));
    fireEvent.click(screen.getByRole("button", { name: "Да, отменить обращение" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/tasks/task", {
      action: "cancel", expectedVersion: 7, operationId: "11111111-1111-4111-8111-111111111111",
    }));
  });

  it("names the assigned specialist without inventing an author action", async () => {
    mount({ ...base, state: "IN_PROGRESS", executorId: "executor", executorName: "Мария" }, true);
    expect(await screen.findByText("Вашим обращением занимается Мария.")).toBeVisible();
    expect(screen.getByText(/Сейчас от вас не требуется действий/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Отметить как решённое|Отменить обращение/ })).not.toBeInTheDocument();
  });

  it("tells the waiting author to use the explicit answer action rather than ordinary discussion", async () => {
    mount({ ...base, state: "NEEDS_INFO", executorId: "executor" }, true);
    expect(await screen.findByText("Статус: ждём вашего ответа")).toBeVisible();
    expect(screen.getByText("Специалист ждёт ваш ответ.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ответить и вернуть в работу" }));
    expect(screen.getByText(/Обычное сообщение в обсуждении этого не делает/)).toBeVisible();
    expect(screen.getByRole("dialog")).toHaveTextContent("выберите уже прикреплённый файл");
    expect(screen.getByRole("button", { name: "Ответить и вернуть в работу" })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it.each(["COMPLETED", "CLOSED"] as const)("explains %s to the author without requiring acceptance or granting close", async state => {
    mount({ ...base, state }, true);
    expect(await screen.findByText(state === "COMPLETED" ? "Специалист отметил обращение как решённое." : "Работа по обращению завершена.")).toBeVisible();
    expect(screen.getByText(/Если проблема осталась/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Проблема не решена" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Закрыть решённое обращение" })).not.toBeInTheDocument();
  });

  it("explains cancellation without promising restoration or offering a transition", async () => {
    mount({ ...base, state: "CANCELLED" }, true);
    expect(await screen.findByText("Статус: отменено")).toBeVisible();
    expect(screen.getByText("Обращение отменено. Работа по нему прекращена.")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/восстановить/i)).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("explains the question transition while preserving its optional question and canonical command", async () => {
    mount({ ...base, state: "IN_PROGRESS", executorId: "executor", permissions: { ...base.permissions, isAuthor: false, isExecutor: true } }, true);
    fireEvent.click(await screen.findByRole("button", { name: "Задать вопрос автору" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Исполнитель сохранится");
    expect(screen.getByLabelText("Ваш вопрос автору (необязательно)")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Отправить вопрос" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/tasks/task", {
      action: "request_info", expectedVersion: 7, operationId: "11111111-1111-4111-8111-111111111111",
    }));
  });

  it("explains a temporary action block without posting", async () => {
    mocks.get.mockResolvedValue({ ...base, state: "SUBMITTED" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
    render(<QueryClientProvider client={client}><TaskRequestLifecycleControls taskId="task" projectId="project" disabled compact /></QueryClientProvider>);
    const cancel = await screen.findByRole("button", { name: "Отменить обращение" });
    expect(cancel).toBeDisabled();
    expect(screen.getByText(/Действия временно недоступны. Следуйте сообщению о сохранении выше/)).toBeVisible();
    fireEvent.click(cancel);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("shows a separate close action only for solved requests with explicit canClose", async () => {
    mount({ ...base, state: "COMPLETED", permissions: { ...base.permissions, isAuthor: false, canClose: true } });
    expect(await screen.findByText("Статус: решено")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть решённое обращение" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/tasks/task", expect.objectContaining({ action: "close", expectedVersion: 7 })));
  });
  it("lets the draft author submit through the canonical lifecycle endpoint", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Отправить обращение/ }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce());
    expect(mocks.post).toHaveBeenCalledWith("/api/tasks/task", {
      operationId: "11111111-1111-4111-8111-111111111111",
      expectedVersion: 7,
      action: "submit",
    });
  });

  it("hides transitions a plain participant cannot perform", async () => {
    mount({
      ...base,
      state: "SUBMITTED",
      permissions: { ...base.permissions, isAuthor: false, canParticipate: true },
    });
    await screen.findByText("Статус: новое обращение");
    expect(screen.queryByRole("button", { name: /Взять в работу/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Назначить исполнителя/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Отменить/ })).toBeNull();
    expect(screen.getByText(/Дождитесь ответа специалиста/)).toBeTruthy();
  });

  it("takes a submitted request into work for an eligible executor", async () => {
    mount({
      ...base,
      state: "SUBMITTED",
      permissions: { ...base.permissions, isAuthor: false, canExecute: true },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Взять в работу/ }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/tasks/task",
      expect.objectContaining({ action: "take", expectedVersion: 7 }),
    ));
  });

  it.each(["COMPLETED", "CLOSED"] as const)("requires a reason to reopen a %s request", async state => {
    mount({ ...base, state });
    fireEvent.click(await screen.findByRole("button", { name: /Проблема не решена/ }));
    const confirm = screen.getByRole("button", { name: "Проблема не решена" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Почему проблема не решена"), { target: { value: "Нужно доработать" } });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/tasks/task",
      expect.objectContaining({ action: "reopen", reason: "Нужно доработать" }),
    ));
  });
  it.each(["author", "administrator", "department-leader", "ordinary-member"])("does not infer a close button from the %s role without explicit canClose", async role => {
    mount({ ...base, state: "COMPLETED", permissions: { ...base.permissions, isAuthor: role === "author", isLeader: role === "department-leader", isGroupMember: role === "ordinary-member", canClose: false } });
    await screen.findByText("Статус: решено");
    expect(screen.queryByRole("button", { name: "Закрыть решённое обращение" })).toBeNull();
  });
  it("retries unknown close with the same UUID/version despite a background snapshot advancement", async () => {
    const solved = { ...base, state: "COMPLETED" as const, permissions: { ...base.permissions, canClose: true } };
    const uuid = vi.fn().mockReturnValueOnce("11111111-1111-4111-8111-111111111111").mockReturnValue("22222222-2222-4222-8222-222222222222");
    vi.stubGlobal("crypto", { randomUUID: uuid });
    mocks.post.mockRejectedValueOnce(new TypeError("Synthetic lost ACK")).mockImplementationOnce(async () => { mocks.get.mockResolvedValue({ ...solved, state: "CLOSED", version: 8 }); return { state: "CLOSED", version: 8 }; });
    const client = mount(solved);
    fireEvent.click(await screen.findByRole("button", { name: "Закрыть решённое обращение" }));
    const retry = await screen.findByRole("button", { name: "Повторить закрытие" });
    expect(screen.getByRole("button", { name: "Проблема не решена" })).toBeDisabled();
    client.setQueryData(["task-lifecycle", "task"], { ...solved, version: 99 });
    fireEvent.click(retry);
    await screen.findByText("Статус: закрыто");
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1]).toEqual(mocks.post.mock.calls[0]);
    expect(mocks.post.mock.calls[1][1]).toMatchObject({ expectedVersion: 7, action: "close" });
    expect(uuid).toHaveBeenCalledOnce();
  });
  it("retries only reading after committed close and failed refetch", async () => {
    const solved = { ...base, state: "COMPLETED" as const, permissions: { ...base.permissions, canClose: true } };
    mount(solved);
    mocks.post.mockImplementationOnce(async () => { mocks.get.mockRejectedValue(Object.assign(new Error("Synthetic read failure"), { status: 503 })); return { state: "CLOSED", version: 8 }; });
    fireEvent.click(await screen.findByRole("button", { name: "Закрыть решённое обращение" }));
    const read = await screen.findByRole("button", { name: "Обновить карточку" });
    mocks.get.mockResolvedValue({ ...solved, state: "CLOSED", version: 8 }); fireEvent.click(read);
    await screen.findByText("Статус: закрыто"); expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.toast.success).toHaveBeenCalledWith("Обращение закрыто");
  });
  it("never carries an unresolved close intent into a different task identity", async () => {
    const solved = { ...base, state: "COMPLETED" as const, permissions: { ...base.permissions, canClose: true } };
    mocks.get.mockImplementation(async (path: string) => path.includes("/other/") ? { ...solved, taskId: "other", version: 42 } : solved);
    mocks.post.mockRejectedValue(new TypeError("Synthetic unknown result"));
    const uuid = vi.fn().mockReturnValueOnce("11111111-1111-4111-8111-111111111111").mockReturnValue("22222222-2222-4222-8222-222222222222");
    vi.stubGlobal("crypto", { randomUUID: uuid });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
    const view = render(<QueryClientProvider client={client}><TaskRequestLifecycleControls taskId="task" projectId="project" /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Закрыть решённое обращение" }));
    await screen.findByRole("button", { name: "Повторить закрытие" });
    view.rerender(<QueryClientProvider client={client}><TaskRequestLifecycleControls taskId="other" projectId="project" /></QueryClientProvider>);
    const close = await screen.findByRole("button", { name: "Закрыть решённое обращение" });
    expect(close).toBeEnabled(); fireEvent.click(close);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1]).toEqual(["/api/tasks/other", { action: "close", expectedVersion: 42, operationId: "22222222-2222-4222-8222-222222222222" }]);
  });

  it("answers a clarification with one comment and never with an empty response", async () => {
    mocks.post.mockImplementation(async (url: string) =>
      url.endsWith("/messages")
        ? { id: "comment-1" }
        : { taskId: "task", version: 8, state: "IN_PROGRESS" });
    mount({
      ...base,
      state: "NEEDS_INFO",
      executorId: "executor",
      executorName: "Исполнитель",
      attachments: [{ id: "0a6e3b9e-3dcb-402e-891a-d1074b75d40f", name: "ответ.pdf", size: 10, mime: "application/pdf" }],
    });
    fireEvent.click(await screen.findByRole("button", { name: /Ответить и вернуть в работу/ }));
    const send = screen.getByRole("button", { name: "Ответить и вернуть в работу" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[0][0]).toBe("/api/tasks/task/messages");
    expect(mocks.post.mock.calls[0][1]).toMatchObject({
      contentText: "",
      attachments: [{ url: "/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f", name: "ответ.pdf" }],
    });
    expect(mocks.post.mock.calls[1][0]).toBe("/api/tasks/task");
    expect(mocks.post.mock.calls[1][1]).toMatchObject({
      action: "answer_info",
      response: {
        commentId: "comment-1",
        attachmentId: "0a6e3b9e-3dcb-402e-891a-d1074b75d40f",
      },
    });
  });

  it.each([false, true])("deletes a draft through the existing DELETE handler (compact=%s)", async compact => {
    const onChanged = vi.fn();
    mocks.get.mockResolvedValue(base);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    render(
      <QueryClientProvider client={client}>
        <TaskRequestLifecycleControls taskId="task" projectId="project" onChanged={onChanged} compact={compact} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Удалить черновик/ }));
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("/api/tasks/task"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });
});

describe("compact lifecycle actions", () => {
  it("keeps executor progression visible and sends completion through the canonical command", async () => {
    mount({ ...base, state: "IN_PROGRESS", executorId: "executor", executorName: "Специалист", permissions: { ...base.permissions, isAuthor: false, isExecutor: true, canExecute: true } }, true);
    expect(await screen.findByRole("button", { name: "Задать вопрос автору" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Отметить как решённое" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/tasks/task", expect.objectContaining({ action: "complete", expectedVersion: 7 })));
  });
  it("does not reuse another actor's cached permissions", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } }); clients.push(client);
    client.setQueryData(["task-lifecycle", "task", "applicant"], { ...base, state: "SUBMITTED", permissions: { ...base.permissions, canExecute: false } });
    mocks.get.mockResolvedValue({ ...base, state: "SUBMITTED", permissions: { ...base.permissions, isAuthor: false, canExecute: true } });
    render(<QueryClientProvider client={client}><TaskRequestLifecycleControls taskId="task" projectId="project" actorId="executor" compact /></QueryClientProvider>);
    expect(await screen.findByRole("button", { name: /Взять в работу/ })).toBeVisible();
    expect(mocks.get).toHaveBeenCalledWith("/api/tasks/task/lifecycle");
  });
  it("refreshes cached permissions when the same actor reopens an appeal", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } }); clients.push(client);
    client.setQueryData(["task-lifecycle", "task", "executor"], { ...base, state: "SUBMITTED", permissions: { ...base.permissions, canExecute: false } });
    mocks.get.mockResolvedValue({ ...base, state: "SUBMITTED", permissions: { ...base.permissions, isAuthor: false, canExecute: true } });
    render(<QueryClientProvider client={client}><TaskRequestLifecycleControls taskId="task" projectId="project" actorId="executor" compact /></QueryClientProvider>);
    expect(await screen.findByRole("button", { name: /Взять в работу/ })).toBeVisible();
    expect(mocks.get).toHaveBeenCalledOnce();
  });
  it("explains why there are no actions instead of rendering an empty strip", async () => {
    mount({ ...base, state: "NEEDS_INFO", permissions: { ...base.permissions, isAuthor: false } }, true);
    expect(await screen.findByText("Статус: ждём ответа автора")).toBeVisible();
    expect(screen.getByText(/Дождитесь ответа автора. Обычное сообщение/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Отметить как решённое" })).not.toBeInTheDocument();
  });
  it("preserves canonical submission and draft deletion with a signed status", async () => {
    mount(base, true);
    const submit = await screen.findByRole("button", { name: /Отправить обращение/ });
    expect(screen.queryByText("Жизненный цикл заявки")).not.toBeInTheDocument();
    expect(screen.getByText("Статус: черновик")).toBeVisible();
    expect(screen.getByText(/Проверьте описание и отправьте обращение/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Удалить черновик" })).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/tasks/task", expect.objectContaining({ action: "submit", expectedVersion: 7 })));
  });
  it("explains the next step without offering unavailable transitions to an ordinary participant", async () => {
    mount({ ...base, state: "SUBMITTED", permissions: { ...base.permissions, isAuthor: false } }, true);
    await screen.findByText("Статус: новое обращение");
    expect(screen.queryByRole("button", { name: /Взять в работу|Назначить исполнителя|Отправить обращение/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Дождитесь ответа специалиста/)).toBeVisible();
    expect(screen.getByText("Что делать сейчас:")).toBeVisible();
  });
  it("preserves the eligible executor take action with a plain next step", async () => {
    mount({ ...base, state: "SUBMITTED", permissions: { ...base.permissions, isAuthor: false, canExecute: true } }, true);
    fireEvent.click(await screen.findByRole("button", { name: /Взять в работу/ }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/tasks/task", expect.objectContaining({ action: "take", expectedVersion: 7 })));
    expect(screen.getByText(/После нажатия вы станете исполнителем/)).toBeVisible();
  });
});


it("reuses the answer message clientId after an unknown HTTP outcome", async () => {
  let attempts = 0;
  mocks.post.mockImplementation(async (url: string) => {
    if (url.endsWith("/messages")) {
      if (++attempts === 1) throw new TypeError("Synthetic lost response");
      return { id: "reply-message" };
    }
    return { taskId: "task", version: 8, state: "IN_PROGRESS" };
  });
  mount({ ...base, state: "NEEDS_INFO", executorId: "executor" });
  fireEvent.click(await screen.findByRole("button", { name: /Ответить и вернуть в работу/ }));
  fireEvent.change(screen.getByLabelText("Ответ исполнителю"), { target: { value: "Synthetic answer" } });
  fireEvent.click(screen.getByRole("button", { name: "Ответить и вернуть в работу" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Ответить и вернуть в работу" }));
  await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("Ответ отправлен, обращение возвращено в работу"));
  const writes = mocks.post.mock.calls.filter(([url]) => url.endsWith("/messages"));
  expect(writes).toHaveLength(2);
  expect(writes[0][1].clientId).toMatch(/^[0-9a-f-]{36}$/);
  expect(writes[1][1]).toEqual(writes[0][1]);
  expect(mocks.post.mock.calls.filter(([url]) => !url.endsWith("/messages"))).toHaveLength(1);
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it("launches independent post-commit refreshes together and waits for fresh capabilities", async () => {
  const submitted: TaskLifecycleSnapshot = { ...base, state: "SUBMITTED", permissions: { ...base.permissions, isAuthor: false, canExecute: true } };
  const next: TaskLifecycleSnapshot = { ...submitted, state: "IN_PROGRESS", version: 8, executorId: "actor" };
  const client = mount(submitted);
  const take = await screen.findByRole("button", { name: /Взять в работу/ });
  const lifecycle = deferred<TaskLifecycleSnapshot>(), tasks = deferred<unknown[]>(), activities = deferred<unknown[]>();
  const started: string[] = [];
  const observers = [
    new QueryObserver(client, { queryKey: ["tasks", "project"], staleTime: Infinity, queryFn: () => { started.push("tasks"); return tasks.promise; } }),
    new QueryObserver(client, { queryKey: ["activities", "task"], staleTime: Infinity, queryFn: () => { started.push("activities"); return activities.promise; } }),
  ];
  client.setQueryData(["tasks", "project"], []); client.setQueryData(["activities", "task"], []);
  const unsubscribe = observers.map(observer => observer.subscribe(() => {}));
  mocks.get.mockImplementation(() => { started.push("lifecycle"); return lifecycle.promise; });
  try {
    fireEvent.click(take);
    await waitFor(() => expect(started).toEqual(expect.arrayContaining(["lifecycle", "tasks", "activities"])));
    expect(take).toBeDisabled();
    await act(async () => { tasks.resolve([]); activities.resolve([]); });
    expect(take).toBeDisabled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    await act(async () => lifecycle.resolve(next));
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("Обращение взято в работу"));
    expect(mocks.post).toHaveBeenCalledOnce();
  } finally {
    await act(async () => { tasks.resolve([]); activities.resolve([]); lifecycle.resolve(next); });
    unsubscribe.forEach(stop => stop());
  }
});

it("returns an invoice for correction with a reason while keeping the current executor", async () => {
  const ready = { ...base, state: "IN_PROGRESS" as const, beznalPhase: "INVOICED" as const, executorId: "accountant", executorName: "Бухгалтер",
    permissions: { ...base.permissions, isAuthor: false, canReturnForRevision: true } };
  mount(ready, true, "sales", { code: "INVOICED", label: "Со счётом" });
  await screen.findByRole("heading", { name: "Статус: Со счётом" });
  fireEvent.click(screen.getByRole("button", { name: "Вернуть на уточнение" }));
  expect(screen.getByRole("button", { name: "Вернуть в «Ждут обработки»" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Что нужно поправить" }), { target: { value: "Уточнить количество техники" } });
  mocks.get.mockResolvedValue({ ...ready, beznalPhase: "WAITING", version: 8 });
  fireEvent.click(screen.getByRole("button", { name: "Вернуть в «Ждут обработки»" }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/tasks/task", {
    operationId: "11111111-1111-4111-8111-111111111111", expectedVersion: 7, action: "return_for_revision", reason: "Уточнить количество техники",
  }));
  await screen.findByRole("heading", { name: "Статус: Ждут обработки" });
  expect(screen.getByText(/занимается Бухгалтер/)).toBeVisible();
});

it("retries the exact return intent after an unknown result without editing the frozen reason", async () => {
  const ready = { ...base, state: "IN_PROGRESS" as const, beznalPhase: "INVOICED" as const, executorId: "accountant", permissions: { ...base.permissions, canReturnForRevision: true } };
  mount(ready, true, "sales", { code: "INVOICED", label: "Со счётом" });
  fireEvent.click(await screen.findByRole("button", { name: "Вернуть на уточнение" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Что нужно поправить" }), { target: { value: "Исправить реквизиты" } });
  mocks.post.mockRejectedValueOnce(new Error("lost response"));
  fireEvent.click(screen.getByRole("button", { name: "Вернуть в «Ждут обработки»" }));
  const retry = await screen.findByRole("button", { name: "Повторить возврат" });
  expect(screen.getByRole("textbox", { name: "Что нужно поправить" })).toBeDisabled();
  fireEvent.click(retry);
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
  expect(mocks.post.mock.calls[1]).toEqual(mocks.post.mock.calls[0]);
});

it("does not offer return merely because the board says an invoice is ready", async () => {
  mount({ ...base, state: "IN_PROGRESS", beznalPhase: "INVOICED" }, true, "reader", { code: "INVOICED", label: "Со счётом" });
  await screen.findByRole("heading", { name: "Статус: Со счётом" });
  expect(screen.queryByRole("button", { name: "Вернуть на уточнение" })).not.toBeInTheDocument();
});

it("performs exactly one authoritative lifecycle read after an acknowledged close", async () => {
  const solved: TaskLifecycleSnapshot = { ...base, state: "COMPLETED", permissions: { ...base.permissions, canClose: true } };
  const client = mount(solved);
  const close = await screen.findByRole("button", { name: "Закрыть решённое обращение" });
  mocks.get.mockResolvedValue({ ...solved, state: "CLOSED", version: 8 });
  fireEvent.click(close);
  await screen.findByText("Статус: закрыто");
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(mocks.get).toHaveBeenCalledTimes(2); // initial read + single post-commit read
  expect(mocks.post).toHaveBeenCalledOnce();
});

it("does not replay a committed take when refreshing capabilities fails", async () => {
  const submitted: TaskLifecycleSnapshot = { ...base, state: "SUBMITTED", permissions: { ...base.permissions, isAuthor: false, canExecute: true } };
  mount(submitted);
  const take = await screen.findByRole("button", { name: /Взять в работу/ });
  mocks.get.mockRejectedValue(Object.assign(new Error("Synthetic read failure"), { status: 503 }));
  fireEvent.click(take);
  const read = await screen.findByRole("button", { name: "Обновить карточку" });
  expect(take).toBeDisabled();
  expect(mocks.post).toHaveBeenCalledOnce();
  mocks.get.mockResolvedValue({ ...submitted, state: "IN_PROGRESS", version: 8 });
  fireEvent.click(read);
  await screen.findByText("Статус: в работе");
  expect(mocks.post).toHaveBeenCalledOnce();
});


it("keeps committed success when an independent list refresh or host callback fails", async () => {
  mocks.get.mockResolvedValue(base);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const onChanged = vi.fn(() => { throw new Error("Synthetic host refresh failure"); });
  render(<QueryClientProvider client={client}><TaskRequestLifecycleControls taskId="task" projectId="project" onChanged={onChanged} /></QueryClientProvider>);
  const submit = await screen.findByRole("button", { name: /Отправить обращение/ });
  const invalidate = vi.spyOn(client, "invalidateQueries").mockRejectedValue(new Error("Synthetic cache refresh failure"));
  mocks.get.mockResolvedValue({ ...base, state: "SUBMITTED", version: 8 });
  fireEvent.click(submit);
  await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("Обращение отправлено в отдел"));
  expect(onChanged).toHaveBeenCalledOnce(); expect(mocks.post).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).toBeNull();
  invalidate.mockRestore();
});

it("replaces a pre-commit in-flight snapshot instead of using it as fresh capabilities", async () => {
  const submitted: TaskLifecycleSnapshot = { ...base, state: "SUBMITTED", permissions: { ...base.permissions, isAuthor: false, canExecute: true } };
  const client = mount(submitted);
  const take = await screen.findByRole("button", { name: /Взять в работу/ });
  const oldRead = deferred<TaskLifecycleSnapshot>();
  mocks.get.mockReturnValueOnce(oldRead.promise).mockResolvedValue({ ...submitted, state: "IN_PROGRESS", version: 8 });
  const staleRefresh = client.refetchQueries({ queryKey: ["task-lifecycle", "task"] });
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  fireEvent.click(take);
  await screen.findByText("Статус: в работе");
  await act(async () => { oldRead.resolve(submitted); await staleRefresh; });
  expect(screen.getByText("Статус: в работе")).toBeInTheDocument();
  expect(mocks.get).toHaveBeenCalledTimes(3); expect(mocks.post).toHaveBeenCalledOnce();
});


it("recovers a failed post-answer read without creating another comment or transition", async () => {
  const waiting: TaskLifecycleSnapshot = { ...base, state: "NEEDS_INFO", executorId: "executor" };
  mount(waiting);
  mocks.post.mockImplementation(async (url: string) => {
    if (url.endsWith("/messages")) return { id: "answer-committed" };
    mocks.get.mockRejectedValue(Object.assign(new Error("Synthetic read failure"), { status: 503 }));
    return { taskId: "task", version: 8, state: "IN_PROGRESS" };
  });
  fireEvent.click(await screen.findByRole("button", { name: /Ответить и вернуть в работу/ }));
  fireEvent.change(screen.getByLabelText("Ответ исполнителю"), { target: { value: "Answer" } });
  fireEvent.click(screen.getByRole("button", { name: "Ответить и вернуть в работу" }));
  const read = await screen.findByRole("button", { name: "Обновить карточку" });
  mocks.get.mockResolvedValue({ ...waiting, state: "IN_PROGRESS", version: 8 });
  fireEvent.click(read);
  await screen.findByText("Статус: в работе");
  expect(mocks.post.mock.calls.filter(([url]) => url.endsWith("/messages"))).toHaveLength(1);
  expect(mocks.post.mock.calls.filter(([url]) => !url.endsWith("/messages"))).toHaveLength(1);
});

it("requires only an explicit read after a close conflict and never retries the mutation", async () => {
  const solved: TaskLifecycleSnapshot = { ...base, state: "COMPLETED", permissions: { ...base.permissions, canClose: true } };
  mount(solved);
  mocks.post.mockRejectedValue(Object.assign(new Error("Synthetic conflict"), { status: 409 }));
  fireEvent.click(await screen.findByRole("button", { name: "Закрыть решённое обращение" }));
  const read = await screen.findByRole("button", { name: "Обновить карточку" });
  expect(screen.queryByRole("button", { name: "Повторить закрытие" })).toBeNull();
  mocks.get.mockResolvedValue({ ...solved, state: "CLOSED", version: 8 });
  fireEvent.click(read);
  await screen.findByText("Статус: закрыто");
  expect(mocks.post).toHaveBeenCalledOnce();
});


it("releases fresh actions without waiting for slower list or activity refreshes", async () => {
  const submitted: TaskLifecycleSnapshot = { ...base, state: "SUBMITTED", permissions: { ...base.permissions, isAuthor: false, canExecute: true } };
  const next: TaskLifecycleSnapshot = { ...submitted, state: "IN_PROGRESS", version: 8, executorId: "actor", permissions: { ...submitted.permissions, isExecutor: true } };
  const client = mount(submitted);
  const take = await screen.findByRole("button", { name: /Взять в работу/ });
  const lifecycle = deferred<TaskLifecycleSnapshot>(), tasks = deferred<unknown[]>(), activities = deferred<unknown[]>();
  const started: string[] = [];
  const observers = [
    new QueryObserver(client, { queryKey: ["tasks", "project"], staleTime: Infinity, queryFn: () => { started.push("tasks"); return tasks.promise; } }),
    new QueryObserver(client, { queryKey: ["activities", "task"], staleTime: Infinity, queryFn: () => { started.push("activities"); return activities.promise; } }),
  ];
  client.setQueryData(["tasks", "project"], []); client.setQueryData(["activities", "task"], []);
  const unsubscribe = observers.map(observer => observer.subscribe(() => {}));
  mocks.get.mockImplementation(() => { started.push("lifecycle"); return lifecycle.promise; });
  try {
    fireEvent.click(take);
    await waitFor(() => expect(started).toEqual(expect.arrayContaining(["lifecycle", "tasks", "activities"])));
    await act(async () => lifecycle.resolve(next));
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("Обращение взято в работу"));
    expect(screen.getByRole("button", { name: "Отметить как решённое" })).toBeEnabled();
    expect(client.isFetching({ queryKey: ["tasks", "project"] })).toBe(1);
    expect(client.isFetching({ queryKey: ["activities", "task"] })).toBe(1);
    expect(mocks.post).toHaveBeenCalledOnce();
  } finally {
    await act(async () => { tasks.resolve([]); activities.resolve([]); lifecycle.resolve(next); });
    unsubscribe.forEach(stop => stop());
  }
});
