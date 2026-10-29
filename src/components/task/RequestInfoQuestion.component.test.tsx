import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.get }));

import { RequestInfoQuestion } from "./RequestInfoQuestion";

const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const ui = (taskId = "task", actorId = "author", version = 7) => (
    <QueryClientProvider client={client}>
      <RequestInfoQuestion key={JSON.stringify([taskId, actorId, version])} taskId={taskId} actorId={actorId} version={version} />
    </QueryClientProvider>
  );
  return { client, ui };
}

beforeEach(() => mocks.get.mockReset());
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

describe("request info question", () => {
  it("does not read or reveal a question without an actor identity", () => {
    const { client } = setup();
    client.setQueryData(["request-info-question", "task", null, 7], "Кешированный вопрос");
    render(<QueryClientProvider client={client}><RequestInfoQuestion taskId="task" version={7} /></QueryClientProvider>);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.queryByText("Кешированный вопрос")).not.toBeInTheDocument();
    expect(screen.queryByText("Вопрос специалиста")).not.toBeInTheDocument();
  });

  it("reads the newest matching activity with an abort signal and renders its reason as plain text", async () => {
    mocks.get.mockResolvedValue([
      { action: "comment_added", newValue: { reason: "Не вопрос" } },
      { action: "request_info_requested", newValue: { reason: "<b>Укажите номер</b>\nИ дату" } },
      { action: "request_info_requested", newValue: { reason: "Старый вопрос" } },
    ]);
    const { ui } = setup(); render(ui());
    const question = await screen.findByText("<b>Укажите номер</b> И дату");
    expect(question.querySelector("b")).toBeNull();
    expect(question.textContent).toBe("<b>Укажите номер</b>\nИ дату");
    expect(screen.queryByText("Старый вопрос")).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith("/api/activities?taskId=task", { signal: expect.any(AbortSignal) });
  });

  it.each([null, {}, { reason: null }, { reason: 123 }, { reason: "  " }, []])("does not substitute an older question for a latest empty or unknown reason %j", async value => {
    mocks.get.mockResolvedValue([
      { action: "request_info_requested", newValue: value },
      { action: "request_info_requested", newValue: { reason: "Старый вопрос" } },
    ]);
    const { ui } = setup(); render(ui());
    expect(await screen.findByText(/Вопрос не указан в последних действиях/)).toBeVisible();
    expect(screen.queryByText("Старый вопрос")).not.toBeInTheDocument();
  });

  it("explains when the returned activity window contains no question", async () => {
    mocks.get.mockResolvedValue([null, "строка", [], { action: "completed" }]);
    const { ui } = setup(); render(ui());
    expect(await screen.findByText(/Вопрос не указан в последних действиях/)).toBeVisible();
  });

  it.each(["not an array", null, { reason: "not an activity list" }])("treats a malformed response as a read failure: %j", async response => {
    mocks.get.mockResolvedValue(response);
    const { ui } = setup(); render(ui());
    expect(await screen.findByRole("alert")).toHaveTextContent("Ошибка загрузки вопроса");
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Вопрос не указан/)).not.toBeInTheDocument();
  });

  it("offers only an explicit read retry after failure", async () => {
    mocks.get.mockRejectedValueOnce(new Error("Synthetic read error"))
      .mockResolvedValue([{ action: "request_info_requested", newValue: { reason: "Актуальный вопрос" } }]);
    const { ui } = setup(); render(ui());
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить вопрос ещё раз" }));
    expect(await screen.findByText("Актуальный вопрос")).toBeVisible();
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it.each(["actor", "version", "task"])("does not display the previous question during %s rotation", async change => {
    const { client, ui } = setup();
    mocks.get.mockResolvedValueOnce([{ action: "request_info_requested", newValue: { reason: "Прежний вопрос" } }]);
    const view = render(ui());
    await screen.findByText("Прежний вопрос");
    const taskId = change === "task" ? "other-task" : "task";
    const actorId = change === "actor" ? "other-actor" : "author";
    const version = change === "version" ? 8 : 7;
    client.setQueryData(["request-info-question", taskId, actorId, version], "Кешированный вопрос");
    let resolve!: (value: unknown) => void;
    mocks.get.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    view.rerender(ui(taskId, actorId, version));
    expect(screen.getByRole("status")).toHaveTextContent("Загружаем вопрос");
    expect(screen.queryByText(/Прежний вопрос|Кешированный вопрос/)).not.toBeInTheDocument();
    await act(async () => resolve([{ action: "request_info_requested", newValue: { reason: "Новый вопрос" } }]));
    expect(await screen.findByText("Новый вопрос")).toBeVisible();
  });

  it("hides a same-key cached question until a fresh read and does not reveal it after failure", async () => {
    const { client, ui } = setup();
    client.setQueryData(["request-info-question", "task", "author", 7], "Кешированный вопрос");
    mocks.get.mockRejectedValueOnce(new Error("Synthetic failure"));
    render(ui());
    expect(screen.queryByText("Кешированный вопрос")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Ошибка загрузки вопроса");
    expect(screen.queryByText("Кешированный вопрос")).not.toBeInTheDocument();
  });
});
