import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.fetch }));

import { TaskRelatedRequests } from "./TaskRelatedRequests";
import { encodeRequestDescription } from "@/lib/request-presentation";

const direct = {
  id: "related-direct",
  title: "Повторный заказ пропуска",
  projectId: "project-one",
  projectName: "Хозяйственный отдел",
  state: "IN_PROGRESS",
  isDirect: true,
  url: "/projects/project-one/tasks/related-direct",
};
const indirect = {
  id: "related-indirect",
  title: "Пропуск для подрядчика",
  projectId: "project-two",
  projectName: "Отдел охраны",
  state: "SUBMITTED",
  isDirect: false,
  url: "/projects/project-two/tasks/related-indirect",
};

function projection(over: Record<string, unknown> = {}) {
  return {
    taskId: "task-a",
    version: 7,
    canManage: true,
    items: [direct, indirect],
    limited: false,
    ...over,
  };
}

const clients: QueryClient[] = [];
function setup(
  taskId = "task-a",
  actorId = "actor-one",
  version = 7,
  onChanged?: () => void | Promise<void>,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const ui = (nextTaskId = taskId, nextActorId = actorId, nextVersion = version, key?: string) => (
    <QueryClientProvider client={client}>
      <TaskRelatedRequests
        key={key}
        taskId={nextTaskId}
        actorId={nextActorId}
        version={nextVersion}
        onChanged={onChanged}
      />
    </QueryClientProvider>
  );
  return { client, ui };
}

function renderExpanded(ui: Parameters<typeof render>[0]) {
  const view = render(ui);
  fireEvent.click(screen.getByText("Связанные обращения").closest("summary")!);
  return view;
}

function conflict(): Error {
  return Object.assign(new Error("synthetic raw conflict text"), { status: 409 });
}

beforeEach(() => { mocks.fetch.mockReset(); });
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
});

describe("task related requests", () => {
  it("starts collapsed with the accessible count and preserves search input across toggles", async () => {
    mocks.fetch.mockResolvedValue(projection());
    const { ui } = setup();
    render(ui());
    const summary = screen.getByText("Связанные обращения").closest("summary")!;
    const details = summary.parentElement!;
    expect(details).not.toHaveAttribute("open");
    expect(await screen.findByLabelText("Доступных связанных обращений: 2")).toBeVisible();
    expect(screen.getByText(/Связь помогает найти обращения/)).not.toBeVisible();
    expect(screen.getByText(direct.title)).not.toBeVisible();

    await userEvent.click(summary);
    expect(details).toHaveAttribute("open");
    expect(screen.getByRole("link", { name: new RegExp(direct.title) })).toHaveAttribute("href", direct.url);
    await userEvent.type(screen.getByRole("searchbox"), "ремонт");
    await userEvent.click(summary);
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByDisplayValue("ремонт")).not.toBeVisible();
    await userEvent.click(summary);
    expect(screen.getByRole("searchbox")).toHaveValue("ремонт");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not show a zero count while the projection is loading or unavailable", async () => {
    let rejectRead!: (error: Error) => void;
    mocks.fetch.mockImplementation(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    const { ui } = setup();
    render(ui());
    const summary = screen.getByText("Связанные обращения").closest("summary")!;
    expect(summary).toHaveTextContent("Загрузка…");
    expect(screen.queryByLabelText(/Доступных связанных обращений/)).not.toBeInTheDocument();
    await act(async () => { rejectRead(Object.assign(new Error("synthetic private error"), { status: 403 })); });
    await waitFor(() => expect(summary).toHaveTextContent("Не удалось загрузить"));
    expect(screen.queryByLabelText(/Доступных связанных обращений/)).not.toBeInTheDocument();
    expect(summary.parentElement).not.toHaveAttribute("open");
    await userEvent.click(summary);
    expect(screen.getByRole("button", { name: "Повторить загрузку связанных обращений" })).toBeVisible();
    expect(screen.queryByText("synthetic private error")).not.toBeInTheDocument();
  });

  it("labels a limited result as shown items rather than an exhaustive count", async () => {
    mocks.fetch.mockResolvedValue(projection({ limited: true }));
    const { ui } = setup();
    render(ui());
    expect(await screen.findByLabelText("Доступных связанных обращений: 2")).toHaveTextContent("Показано: 2");
  });

  it("keeps the committed result and notice when the parent adopts its new task version", async () => {
    let reads = 0;
    mocks.fetch.mockImplementation(async (_url, init) => {
      if (init?.method === "DELETE") return projection({ version: 8, items: [indirect] });
      reads += 1;
      if (reads > 1) return new Promise(() => {});
      return projection();
    });
    const { ui } = setup();
    const view = renderExpanded(ui());
    await screen.findByRole("link", { name: /Повторный заказ пропуска/ });
    await userEvent.click(screen.getByRole("button", { name: "Убрать прямую связь" }));
    await userEvent.click(screen.getByRole("button", { name: "Убрать связь" }));
    await screen.findByText(/Прямая связь убрана/);
    expect(screen.getByLabelText("Доступных связанных обращений: 1")).toHaveTextContent("1");
    view.rerender(ui("task-a", "actor-one", 8));
    expect(screen.getByText(/Прямая связь убрана/)).toBeVisible();
    expect(screen.getByRole("link", { name: /Пропуск для подрядчика/ })).toBeVisible();
    expect(screen.queryByText(/Загружаем связанные обращения/)).not.toBeInTheDocument();
    expect(reads).toBe(1);
    view.rerender(ui("task-a", "actor-one", 9));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByRole("link", { name: /Пропуск для подрядчика/ })).toBeVisible();
    expect(screen.getByText(/Прямая связь убрана/)).toBeVisible();
  });

  it("hides previously loaded neighbours when a background read confirms revoked access", async () => {
    mocks.fetch.mockResolvedValueOnce(projection()).mockRejectedValue(Object.assign(new Error("PRIVATE"), { status: 403 }));
    const { ui, client } = setup();
    renderExpanded(ui());
    await screen.findByRole("link", { name: /Повторный заказ пропуска/ });
    await act(async () => { await client.refetchQueries({ queryKey: ["task-related", "actor-one", "task-a"], exact: true }); });
    await waitFor(() => expect(screen.queryByRole("link", { name: /Повторный заказ пропуска/ })).not.toBeInTheDocument());
    expect(screen.queryByText("PRIVATE")).not.toBeInTheDocument();
  });

  it("cancels an in-flight background read before mutation so a late poll cannot replace the confirmed result", async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    let reads = 0;
    mocks.fetch.mockImplementation((url, init) => {
      if (init?.method === "DELETE") {
        expect(oldSignal?.aborted).toBe(true);
        return Promise.resolve(projection({ version: 8, items: [indirect] }));
      }
      if (url === "/api/tasks/task-a/related" && ++reads > 1) {
        oldSignal = init?.signal;
        return new Promise(resolve => { resolveOld = resolve; });
      }
      return Promise.resolve(projection());
    });
    const { ui, client } = setup();
    renderExpanded(ui());
    await screen.findByRole("link", { name: /Повторный заказ пропуска/ });
    void client.refetchQueries({ queryKey: ["task-related", "actor-one", "task-a"], exact: true }).catch(() => undefined);
    await waitFor(() => expect(resolveOld).toBeDefined());
    expect(screen.getByRole("link", { name: /Повторный заказ пропуска/ })).toBeVisible();
    expect(screen.queryByText(/Загружаем связанные обращения/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Убрать прямую связь" }));
    await userEvent.click(screen.getByRole("button", { name: "Убрать связь" }));
    expect(await screen.findByText(/Прямая связь убрана/)).toBeVisible();
    await act(async () => { resolveOld?.(projection()); });
    expect(screen.queryByRole("link", { name: /Повторный заказ пропуска/ })).not.toBeInTheDocument();
    expect(client.getQueryData(["task-related", "actor-one", "task-a"])).toMatchObject({ version: 8, items: [indirect] });
  });
  it("refreshes the actor-scoped projection after 15 seconds without hiding confirmed rows", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      mocks.fetch.mockImplementation(async (url, init) => {
        if (url === "/api/tasks/task-a/related" && init?.method === "GET") reads += 1;
        return projection();
      });
      const { ui } = setup();
      renderExpanded(ui());
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("link", { name: /Повторный заказ пропуска/ })).toBeVisible();
      expect(reads).toBe(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
      expect(reads).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(reads).toBe(2);
      expect(screen.getByRole("link", { name: /Повторный заказ пропуска/ })).toBeVisible();
      expect(screen.queryByText(/Загружаем связанные обращения/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["https://evil.example/projects/p/tasks/candidate-one", /Внешние ссылки не используются/],
    ["https://user:pass@localhost/projects/p/tasks/candidate-one", /Внешние ссылки не используются/],
    ["https://localhost/projects/p/tasks/candidate-one?secret=x", /Внешние ссылки не используются/],
    ["//localhost/projects/p/tasks/candidate-one", /Внешние ссылки не используются/],
    ["https://localhost/x/../projects/p/tasks/candidate-one", /Внешние ссылки не используются/],
    ["/projects/p/tasks/task-a", /Нельзя связать обращение с самим собой/],
  ])("rejects noncanonical or self pasted URL without making a lookup: %s", async (url, message) => {
    mocks.fetch.mockResolvedValue(projection());
    const { ui } = setup();
    renderExpanded(ui());
    await screen.findByRole("link", { name: /Повторный заказ пропуска/ });
    const input = screen.getByRole("searchbox");
    await userEvent.type(input, url);
    await userEvent.click(screen.getByRole("button", { name: "Найти обращения" }));
    expect(await screen.findByText(message)).toBeVisible();
    expect(mocks.fetch.mock.calls.every(([url]) => url === "/api/tasks/task-a/related")).toBe(true);
  });

  it("looks up a pasted canonical card only internally and isolates parent refresh failure after commit", async () => {
    const onChanged = vi.fn().mockRejectedValue(new Error("synthetic refresh failure"));
    mocks.fetch.mockImplementation(async (url, init) => {
      if (url === "/api/tasks/candidate-one?view=details") return { id: "candidate-one", projectId: "p", title: "Карточка по ссылке", project: { name: "Отдел" } };
      if (init?.method === "POST") return projection({ version: 8 });
      return projection();
    });
    const { ui, client } = setup("task-a", "actor-one", 7, onChanged);
    const cancel = vi.spyOn(client, "cancelQueries");
    renderExpanded(ui());
    await screen.findByRole("link", { name: /Повторный заказ пропуска/ });
    await userEvent.type(screen.getByRole("searchbox"), "/projects/p/tasks/candidate-one");
    await userEvent.click(screen.getByRole("button", { name: "Найти обращения" }));
    await userEvent.click(await screen.findByRole("radio", { name: /Карточка по ссылке/ }));
    expect(onChanged).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Связать выбранное обращение" }));
    expect(await screen.findByText(/Связь добавлена/)).toBeVisible();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith({ queryKey: ["task-related", "actor-one", "task-a"], exact: true });
    expect(screen.queryByText(/Сервер не подтвердил/)).not.toBeInTheDocument();
    expect(mocks.fetch.mock.calls.every(([url]) => typeof url === "string" && url.startsWith("/api/"))).toBe(true);
    const lookup = mocks.fetch.mock.calls.find(([url]) => url === "/api/tasks/candidate-one?view=details")!;
    expect(lookup[1]).toEqual(expect.objectContaining({ method: "GET", cache: "no-store" }));
    const post = mocks.fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1].body))).toEqual({
      operationId: expect.any(String),
      expectedVersion: 7,
      relatedTaskId: "candidate-one",
    });
  });

  it("does not offer an already related card twice after a URL lookup", async () => {
    mocks.fetch.mockImplementation(async (url) => {
      if (url === "/api/tasks/related-direct?view=details") {
        return { id: "related-direct", projectId: "project-one", title: "Повторный заказ пропуска", project: { name: "Хозяйственный отдел" }, request: { state: "IN_PROGRESS" } };
      }
      return projection();
    });
    const { ui } = setup();
    renderExpanded(ui());
    await screen.findByRole("link", { name: /Повторный заказ пропуска/ });
    await userEvent.type(screen.getByRole("searchbox"), "/projects/project-one/tasks/related-direct");
    await userEvent.click(screen.getByRole("button", { name: "Найти обращения" }));

    const radio = await screen.findByRole("radio", { name: /Повторный заказ пропуска/ });
    expect(radio).toBeDisabled();
    expect(screen.getByText("Уже связана с этим обращением")).toBeVisible();
    expect(screen.getByRole("button", { name: "Связать выбранное обращение" })).toBeDisabled();
    expect(mocks.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("does not reveal a forbidden pasted target", async () => {
    mocks.fetch.mockImplementation(async (url) => {
      if (url === "/api/tasks/candidate-one?view=details") throw Object.assign(new Error("hidden details"), { status: 403 });
      return projection();
    });
    const { ui } = setup();
    renderExpanded(ui());
    await screen.findByRole("link", { name: /Повторный заказ пропуска/ });
    await userEvent.type(screen.getByRole("searchbox"), "/projects/p/tasks/candidate-one");
    await userEvent.click(screen.getByRole("button", { name: "Найти обращения" }));
    expect(await screen.findByText(/Карточка по ссылке недоступна/)).toBeVisible();
    expect(screen.queryByText(/hidden details/)).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(mocks.fetch.mock.calls.every(([url]) => typeof url === "string" && url.startsWith("/api/"))).toBe(true);
  });
  it("separates direct and indirect neighbours and links accessible cards without exposing hidden ids", async () => {
    mocks.fetch.mockResolvedValue(projection({ limited: true }));
    const { ui } = setup();
    renderExpanded(ui());

    expect(await screen.findByRole("link", { name: /Повторный заказ пропуска/ })).toHaveAttribute(
      "href",
      direct.url,
    );
    const directGroup = screen.getByRole("heading", { name: "Прямые связи" }).parentElement!;
    const indirectGroup = screen.getByRole("heading", { name: "Через другое обращение" }).parentElement!;
    expect(within(directGroup).getByText("Прямая связь")).toBeVisible();
    expect(within(directGroup).getByRole("button", { name: "Убрать прямую связь" })).toBeVisible();
    expect(within(indirectGroup).getByRole("heading", { name: "Через другое обращение" })).toBeVisible();
    expect(within(indirectGroup).getAllByText("Через другое обращение")).toHaveLength(2);
    expect(within(indirectGroup).queryByRole("button", { name: /Убрать/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Список ограничен/)).toBeVisible();
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/tasks/task-a/related",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("removes only a direct edge after explicit confirmation and never deletes the cards", async () => {
    mocks.fetch.mockImplementation(async (url?: unknown, init?: RequestInit) => {
      if (typeof url !== "string") return projection();
      if (init?.method === "DELETE") return projection({ version: 8, items: [indirect] });
      return projection();
    });
    const { ui } = setup();
    renderExpanded(ui());

    await screen.findByRole("link", { name: /Повторный заказ пропуска/ });
    await userEvent.click(screen.getByRole("button", { name: "Убрать прямую связь" }));
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
    expect(screen.getByText(/Оба обращения, их файлы и переписка останутся на месте/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Убрать связь" }));
    expect(await screen.findByText(/Прямая связь убрана/)).toBeVisible();
    expect(screen.queryByRole("link", { name: /Повторный заказ пропуска/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Пропуск для подрядчика/ })).toBeVisible();

    const [, init] = mocks.fetch.mock.calls.find(([, options]) => options?.method === "DELETE")!;
    expect(JSON.parse(String(init.body))).toEqual({
      operationId: expect.any(String),
      expectedVersion: 7,
      relatedTaskId: direct.id,
    });
  });

  it("explains author, executor and manager rights when management is not allowed", async () => {
    mocks.fetch.mockResolvedValue(projection({ canManage: false }));
    const { ui } = setup();
    renderExpanded(ui());

    expect(await screen.findByText(/Связи могут менять автор обращения/)).toHaveTextContent(
      "Наблюдение или чтение такого права не дают",
    );
    expect(screen.queryByRole("button", { name: "Убрать прямую связь" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Найти обращения" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Повторный заказ пропуска/ })).toBeVisible();
  });

  it("searches accessible requests but links only after an explicit confirmation", async () => {
    const candidate = {
      id: "candidate-one",
      title: "Заявка на ремонт",
      projectId: "project-one",
      project: { name: "Хозяйственный отдел" },
      request: { state: "SUBMITTED" },
    };
    const linked = {
      id: "candidate-one",
      title: "Заявка на ремонт",
      projectId: "project-one",
      projectName: "Хозяйственный отдел",
      state: "SUBMITTED",
      isDirect: true,
      url: "/projects/project-one/tasks/candidate-one",
    };
    mocks.fetch.mockImplementation(async (url?: unknown, init?: RequestInit) => {
      if (typeof url !== "string") return projection();
      if (url.startsWith("/api/tasks?")) {
        return [{ id: "task-a", title: "Текущее обращение", projectId: "p", project: { name: "Отдел" } }, candidate];
      }
      if (init?.method === "POST") return projection({ version: 8, items: [direct, linked] });
      return projection({ items: [] });
    });
    const { ui } = setup();
    renderExpanded(ui());

    await screen.findByText(/Связанных обращений пока нет/);
    await userEvent.type(screen.getByLabelText("Найти доступное обращение"), "ремонт");
    expect(mocks.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Найти обращения" }));
    const radio = await screen.findByRole("radio", { name: /Заявка на ремонт/ });
    expect(screen.queryByRole("radio", { name: /Текущее обращение/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Не удалось выполнить поиск/)).not.toBeInTheDocument();
    expect(mocks.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    await userEvent.click(radio);
    expect(radio).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Связать выбранное обращение" }));

    expect(await screen.findByRole("link", { name: "Заявка на ремонт" })).toBeVisible();
    const post = mocks.fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(post[0]).toBe("/api/tasks/task-a/related");
    expect(JSON.parse(String(post[1].body))).toEqual({
      operationId: expect.any(String),
      expectedVersion: 7,
      relatedTaskId: "candidate-one",
    });
    const searchCall = mocks.fetch.mock.calls.find(([url]) => String(url).startsWith("/api/tasks?"))!;
    expect(searchCall[0]).toBe(`/api/tasks?search=${encodeURIComponent("ремонт")}&limit=8`);
    expect(searchCall[1]).toEqual(expect.objectContaining({ method: "GET", cache: "no-store" }));
  });

  it("keeps search failures free of raw details and does not invent inaccessible targets", async () => {
    mocks.fetch.mockImplementation(async (url?: unknown) => {
      if (typeof url !== "string") return projection();
      if (url.startsWith("/api/tasks?")) {
        throw Object.assign(new Error("synthetic private search token"), { status: 500 });
      }
      return projection({ items: [{ ...direct }] });
    });
    const { ui } = setup();
    renderExpanded(ui());

    await screen.findByRole("link", { name: /Повторный заказ пропуска/ });
    await userEvent.type(screen.getByLabelText("Найти доступное обращение"), "секрет");
    await userEvent.click(screen.getByRole("button", { name: "Найти обращения" }));

    expect(await screen.findByText(/Не удалось выполнить поиск доступных обращений/)).toBeVisible();
    expect(screen.queryByText(/synthetic private search token/)).not.toBeInTheDocument();
    expect(screen.queryByText(/секрет/)).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("does not show a previous task's neighbours when an older read resolves after the switch", async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise(done => { resolveFirst = done; });
    mocks.fetch.mockImplementation(async (url?: unknown) => {
      if (typeof url !== "string") return projection();
      if (url === "/api/tasks/task-a/related") return first;
      return projection({ taskId: "task-b", version: 3, items: [{ ...direct, id: "task-b-neighbour", title: "Сосед задачи Б", url: "/projects/project-one/tasks/task-b-neighbour" }] });
    });
    const { ui } = setup();
    const view = renderExpanded(ui());
    expect(screen.getByRole("status")).toHaveTextContent("Загружаем связанные обращения");

    view.rerender(ui("task-b", "actor-one", 3, "task-b"));
    fireEvent.click(screen.getByText("Связанные обращения").closest("summary")!);
    expect(await screen.findByRole("link", { name: /Сосед задачи Б/ })).toBeVisible();

    await act(async () => { resolveFirst(projection()); });
    expect(screen.queryByRole("link", { name: /Повторный заказ пропуска/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Сосед задачи Б/ })).toBeVisible();
  });

  it.each([
    ["a foreign card url", { ...direct, url: "//evil.example/card" }],
    ["the current task as its own neighbour", { ...direct, id: "task-a" }],
    ["a duplicate neighbour", { ...direct }],
    ["a missing title", { ...direct, title: "   " }],
  ])("rejects %s instead of rendering a partially trusted projection", async (_label, item) => {
    const items = _label === "a duplicate neighbour" ? [direct, item] : [item];
    mocks.fetch.mockResolvedValue(projection({ items }));
    const { ui } = setup();
    renderExpanded(ui());

    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить связанные обращения");
    expect(screen.queryByRole("link", { name: /Повторный заказ пропуска/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/evil\.example/)).not.toBeInTheDocument();
  });

  it("shows a loading state, a safe error and an explicit retry", async () => {
    mocks.fetch.mockRejectedValueOnce(Object.assign(new Error("synthetic private read"), { status: 503 }))
      .mockResolvedValue(projection());
    const { ui } = setup();
    renderExpanded(ui());

    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить связанные обращения");
    expect(screen.queryByText(/synthetic private read/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Повторить загрузку связанных обращений" }));
    expect(await screen.findByRole("link", { name: /Повторный заказ пропуска/ })).toBeVisible();
  });

  it("keeps the selected target after a conflict and starts a fresh operation instead of replaying", async () => {
    const candidate = { id: "candidate-one", title: "Заявка на ремонт", projectId: "p", project: { name: "Отдел" }, request: { state: "SUBMITTED" } };
    const linked = { id: "candidate-one", title: "Заявка на ремонт", projectId: "p", projectName: "Отдел", state: "SUBMITTED", isDirect: true, url: "/projects/p/tasks/candidate-one" };
    let posts = 0;
    mocks.fetch.mockImplementation(async (url?: unknown, init?: RequestInit) => {
      if (typeof url !== "string") return projection();
      if (url.startsWith("/api/tasks?")) return [candidate];
      if (init?.method === "POST") {
        posts += 1;
        if (posts === 1) throw conflict();
        return projection({ version: 9, items: [linked] });
      }
      return projection({ version: posts === 0 ? 7 : 8, items: [] });
    });
    const { ui } = setup();
    renderExpanded(ui());

    await screen.findByText(/Связанных обращений пока нет/);
    await userEvent.type(screen.getByLabelText("Найти доступное обращение"), "ремонт");
    await userEvent.click(screen.getByRole("button", { name: "Найти обращения" }));
    const radio = await screen.findByRole("radio", { name: /Заявка на ремонт/ });
    await userEvent.click(radio);
    await userEvent.click(screen.getByRole("button", { name: "Связать выбранное обращение" }));

    expect(await screen.findByText(/Карточка уже изменилась/)).toBeVisible();
    expect(screen.queryByText(/synthetic raw conflict text/)).not.toBeInTheDocument();
    expect(radio).toBeChecked();
    await waitFor(() => expect(posts).toBe(1));
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Связать выбранное обращение" }));
    expect(await screen.findByText(/Связь добавлена/)).toBeVisible();
    const bodies = mocks.fetch.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ expectedVersion: 8, relatedTaskId: "candidate-one" });
    expect(bodies[1].operationId).not.toBe(bodies[0].operationId);
  });

  it("replays exactly the same command after an unconfirmed mutation and preserves the selection", async () => {
    const candidate = { id: "candidate-one", title: "Заявка на ремонт", projectId: "p", project: { name: "Отдел" }, request: { state: "SUBMITTED" } };
    const linked = { id: "candidate-one", title: "Заявка на ремонт", projectId: "p", projectName: "Отдел", state: "SUBMITTED", isDirect: true, url: "/projects/p/tasks/candidate-one" };
    let posts = 0;
    mocks.fetch.mockImplementation(async (url?: unknown, init?: RequestInit) => {
      if (typeof url !== "string") return projection();
      if (url.startsWith("/api/tasks?")) return [candidate];
      if (init?.method === "POST") {
        posts += 1;
        if (posts === 1) throw new TypeError("Failed to fetch");
        return projection({ version: 8, items: [linked] });
      }
      return projection({ items: [] });
    });
    const { ui } = setup();
    renderExpanded(ui());

    await screen.findByText(/Связанных обращений пока нет/);
    await userEvent.type(screen.getByLabelText("Найти доступное обращение"), "ремонт");
    await userEvent.click(screen.getByRole("button", { name: "Найти обращения" }));
    const radio = await screen.findByRole("radio", { name: /Заявка на ремонт/ });
    await userEvent.click(radio);
    await userEvent.click(screen.getByRole("button", { name: "Связать выбранное обращение" }));

    expect(await screen.findByText(/Сервер не подтвердил изменение связи/)).toBeVisible();
    expect(radio).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Повторить ту же команду" }));
    expect(await screen.findByText(/Связь добавлена/)).toBeVisible();

    const bodies = mocks.fetch.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("does not read or reveal neighbours without an actor identity", async () => {
    mocks.fetch.mockResolvedValue(projection());
    const { client, ui } = setup();
    client.setQueryData(["task-related", "actor-one", "task-a"], projection());
    const view = renderExpanded(ui());
    await screen.findByRole("link", { name: /Повторный заказ пропуска/ });
    const reads = mocks.fetch.mock.calls.length;

    view.rerender(ui("task-a", "", 7, "signed-out"));
    expect(screen.queryByRole("link", { name: /Повторный заказ пропуска/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Связанные обращения" })).not.toBeInTheDocument();
    expect(mocks.fetch).toHaveBeenCalledTimes(reads);
  });

  it("previews an accessible result with a brief description, department, state and actual people", async () => {
    const description = encodeRequestDescription("Клиент просит заменить пропуск, <b>не HTML</b>.", {
      kind: "claim",
      category: "Претензия",
      order: "5305316",
      phone: "+7 921 123-45-67",
      client: "ООО Ромашка",
    });
    const candidate = {
      id: "candidate-one",
      title: "Заявка на ремонт",
      projectId: "project-one",
      description,
      project: { name: "Хозяйственный отдел" },
      request: { state: "IN_PROGRESS", author: { id: "author", name: "Анна" }, executor: { id: "executor", name: "Борис" } },
      createdBy: { name: "Старый автор" },
      assignees: [{ user: { name: "Старый исполнитель" } }],
    };
    mocks.fetch.mockImplementation(async (url?: unknown) => {
      if (typeof url === "string" && url.startsWith("/api/tasks?")) return [candidate];
      return projection({ items: [] });
    });
    const { ui } = setup();
    renderExpanded(ui());

    await screen.findByText(/Связанных обращений пока нет/);
    await userEvent.type(screen.getByLabelText("Найти доступное обращение"), "пропуск анна");
    await userEvent.click(screen.getByRole("button", { name: "Найти обращения" }));

    expect(await screen.findByText((_,node)=>node?.textContent === "Описание: Клиент просит заменить пропуск, не HTML.")).toBeVisible();
    expect(screen.getByText(/Отдел: Хозяйственный отдел\./)).toBeVisible();
    expect(screen.getByText(/Состояние: в работе/)).toBeVisible();
    expect(screen.getByText((_,node)=>node?.textContent === "Люди: Анна, Борис")).toBeVisible();
    expect(screen.queryByText(/Старый автор/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Старый исполнитель/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Сведения об обращении/)).not.toBeInTheDocument();
    expect(screen.queryByText(/5305316/)).not.toBeInTheDocument();

    expect([...document.querySelectorAll("mark")].map(node=>node.textContent)).toEqual(["пропуск","Анна"]);
    const readsBeforeEdit=mocks.fetch.mock.calls.length;
    await userEvent.clear(screen.getByLabelText("Найти доступное обращение"));
    await userEvent.type(screen.getByLabelText("Найти доступное обращение"),"другой запрос");
    expect([...document.querySelectorAll("mark")].map(node=>node.textContent)).toEqual(["пропуск","Анна"]);
    expect(mocks.fetch).toHaveBeenCalledTimes(readsBeforeEdit);
    const open = screen.getByRole("link", { name: "Открыть «Заявка на ремонт» в новой вкладке" });
    expect(open).toHaveAttribute("href", "/projects/project-one/tasks/candidate-one");
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");

    await userEvent.click(screen.getByRole("radio", { name: /Заявка на ремонт/ }));
    expect(mocks.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("shows legacy creator and assignees only for a legacy result and never renders its text as HTML", async () => {
    const candidate = {
      id: "legacy-one",
      title: "Старая заявка",
      projectId: "project-two",
      description: "<p>Пропуск для подрядчика</p><p>Нужен завтра</p><img src=x onerror=alert(1)><script>window.previewExecuted = true</script>",
      project: { name: "Отдел охраны" },
      request: null,
      createdBy: { name: "Иван" },
      assignees: [{ user: { name: "Пётр" } }],
    };
    mocks.fetch.mockImplementation(async (url?: unknown) => {
      if (typeof url === "string" && url.startsWith("/api/tasks?")) return [candidate];
      return projection({ items: [] });
    });
    const { ui } = setup();
    renderExpanded(ui());

    await screen.findByText(/Связанных обращений пока нет/);
    await userEvent.type(screen.getByLabelText("Найти доступное обращение"), "пропуск");
    await userEvent.click(screen.getByRole("button", { name: "Найти обращения" }));

    expect(await screen.findByText("Люди: Иван, Пётр")).toBeVisible();
    expect(screen.getByText((_,node)=>node?.textContent === "Описание: Пропуск для подрядчика Нужен завтра window.previewExecuted = true")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(Object.hasOwn(window, "previewExecuted")).toBe(false);
    expect(screen.queryByText(/<p>|<img|<script/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Открыть «Старая заявка» в новой вкладке" })).toHaveAttribute(
      "href",
      "/projects/project-two/tasks/legacy-one",
    );
  });

  it("does not build a card link from an untrusted project id", async () => {
    const candidate = {
      id: "candidate-one",
      title: "Заявка на ремонт",
      projectId: "../admin",
      project: { name: "Отдел" },
      request: { state: "SUBMITTED" },
    };
    mocks.fetch.mockImplementation(async (url?: unknown) => {
      if (typeof url === "string" && url.startsWith("/api/tasks?")) return [candidate];
      return projection({ items: [] });
    });
    const { ui } = setup();
    renderExpanded(ui());

    await screen.findByText(/Связанных обращений пока нет/);
    await userEvent.type(screen.getByLabelText("Найти доступное обращение"), "ремонт");
    await userEvent.click(screen.getByRole("button", { name: "Найти обращения" }));

    expect(await screen.findByRole("radio", { name: /Заявка на ремонт/ })).toBeVisible();
    expect(screen.queryByRole("link", { name: /Открыть «Заявка на ремонт»/ })).not.toBeInTheDocument();
  });
});
