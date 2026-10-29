import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ actor: "actor-A", status: "authenticated", enabled: true,
  prepare: vi.fn(), send: vi.fn(), snapshot: vi.fn(), post: vi.fn(), listeners: new Set<() => void>(),
}));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: boundary.actor } }, status: boundary.status }) }));
vi.mock("@/lib/api", () => ({ apiPost: boundary.post }));
vi.mock("next/navigation", () => ({ usePathname: () => "/my-tasks" }));
vi.mock("@/lib/telemetry/client", () => ({
  getBrowserTelemetryClient: () => boundary.enabled ? { prepareProblemReport: boundary.prepare, sendProblemReport: boundary.send,
    getBreadcrumbSnapshot: boundary.snapshot, subscribeSessionChange: (callback: () => void) => { boundary.listeners.add(callback); return () => boundary.listeners.delete(callback); } } : null,
  ProblemReportFailure: class extends Error {},
}));
vi.mock("next/dynamic", () => ({ default: () => ReportProblemDialog }));
import { ReportProblemDialog } from "./ReportProblemDialog";
import { ReportProblemButton, problemReportScreen } from "./ReportProblemButton";
const reportId = "11111111-1111-4111-8111-111111111111";
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve: (value: T) => resolve(value), reject: (reason: unknown) => reject(reason) }; }
beforeEach(() => {
  boundary.actor = "actor-A"; boundary.status = "authenticated"; boundary.enabled = true; boundary.listeners.clear();
  boundary.prepare.mockReset().mockImplementation((reason, screen) => Object.freeze({ reportId, reason, screen, breadcrumbCount: 3, truncated: true }));
  boundary.send.mockReset(); boundary.snapshot.mockReset().mockReturnValue([{}, {}, {}, {}, {}]);
  boundary.post.mockReset().mockResolvedValue({ reportId });
});
afterEach(cleanup);
function open() { fireEvent.click(screen.getByRole("button", { name: "Сообщить о проблеме" })); }
it("sends only a fixed reason/screen intent and shows success only after server-confirmed receipt", async () => {
  const ack = deferred<{ reportId: string; breadcrumbCount: number; truncated: boolean }>(); boundary.send.mockReturnValue(ack.promise);
  render(<ReportProblemButton />); open();
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Комментарий (необязательно)" })).toHaveAttribute("maxlength", "2000");
  expect(screen.getByText(/действий: 5/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Не работает кнопка или действие" }));
  fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
  expect(boundary.prepare).toHaveBeenCalledWith("button", "my-tasks");
  expect(boundary.send).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Отправляем…" })).toBeDisabled();
  expect(screen.queryByText("Отчёт отправлен")).not.toBeInTheDocument();
  expect(screen.getByText(/Контекст сокращён/)).toBeInTheDocument();
  await act(async () => ack.resolve({ reportId, breadcrumbCount: 3, truncated: true }));
  expect(screen.getByText("Отчёт отправлен")).toBeInTheDocument();
  expect(screen.getByText(reportId)).toBeInTheDocument();
  expect(boundary.post).not.toHaveBeenCalled();
});
it("retries the same frozen draft after unknown outcome and retains it when closed and reopened", async () => {
  boundary.send.mockRejectedValueOnce(new Error("private raw secret")).mockResolvedValueOnce({ reportId, breadcrumbCount: 3, truncated: true });
  render(<ReportProblemButton />); open();
  fireEvent.click(await screen.findByRole("button", { name: "Отправить сообщение" }));
  await screen.findByRole("alert"); expect(screen.queryByText(/private raw secret/)).not.toBeInTheDocument();
  const draft = boundary.send.mock.calls[0][0];
  fireEvent.click(screen.getByRole("button", { name: "Закрыть окно" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Сообщить о проблеме" })).toHaveFocus();
  open(); fireEvent.click(await screen.findByRole("button", { name: "Повторить отправку" }));
  await screen.findByText("Отчёт отправлен");
  expect(boundary.prepare).toHaveBeenCalledTimes(1);
  expect(boundary.send.mock.calls[1][0]).toBe(draft);
});
it("drops an old identity's pending report and cannot display its late success", async () => {
  const ack = deferred<{ reportId: string; breadcrumbCount: number; truncated: boolean }>(); boundary.send.mockReturnValue(ack.promise);
  const view = render(<ReportProblemButton />); open(); fireEvent.click(await screen.findByRole("button", { name: "Отправить сообщение" }));
  boundary.actor = "actor-B"; view.rerender(<ReportProblemButton />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => ack.resolve({ reportId, breadcrumbCount: 3, truncated: true }));
  open(); await screen.findByRole("dialog");
  expect(screen.queryByText(reportId)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Отправить сообщение" })).toBeInTheDocument();
});
it("clears the frozen intent when the diagnostic session resets, without accepting a late ACK", async () => {
  const ack = deferred<{ reportId: string; breadcrumbCount: number; truncated: boolean }>(); boundary.send.mockReturnValue(ack.promise);
  render(<ReportProblemButton />); open(); fireEvent.click(await screen.findByRole("button", { name: "Отправить сообщение" }));
  act(() => { boundary.listeners.forEach(callback => callback()); });
  await screen.findByRole("alert");
  await act(async () => ack.resolve({ reportId, breadcrumbCount: 3, truncated: true }));
  expect(screen.queryByText("Отчёт отправлен")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Отправить сообщение" })).toBeInTheDocument();
});
it("reports unavailable collection honestly and does not prepare/send a phantom report", async () => {
  boundary.enabled = false; render(<ReportProblemButton />); open();
  fireEvent.click(await screen.findByRole("button", { name: "Отправить сообщение" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Диагностика сейчас недоступна");
  expect(boundary.prepare).not.toHaveBeenCalled(); expect(boundary.send).not.toHaveBeenCalled();
});
it("maps pathnames to closed screen labels without transmitting dynamic identifiers", () => {
  expect(problemReportScreen("/")).toBe("home");
  expect(problemReportScreen("/projects/SECRET_TASK_ID/board")).toBe("board");
  expect(problemReportScreen("/admin/telemetry")).toBe("admin.telemetry");
});

it("sends optional text only to its business endpoint after diagnostic ACK, outside telemetry payload", async () => {
  const ack = deferred<{ reportId: string; breadcrumbCount: number; truncated: boolean }>();
  boundary.send.mockReturnValue(ack.promise);
  render(<ReportProblemButton />); open();
  const text = "После ожидания открылось главное окно\n<script>plain text</script>";
  fireEvent.change(await screen.findByRole("textbox"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
  expect(screen.getByRole("textbox")).toBeDisabled(); expect(boundary.post).not.toHaveBeenCalled();
  expect(boundary.prepare).toHaveBeenCalledWith("slow", "my-tasks");
  expect(JSON.stringify(boundary.send.mock.calls)).not.toContain(text);
  await act(async () => ack.resolve({ reportId, breadcrumbCount: 3, truncated: false }));
  await screen.findByText("Отчёт отправлен");
  expect(boundary.post).toHaveBeenCalledWith(`/api/problem-reports/${reportId}/comment`, { comment: text });
  fireEvent.click(screen.getByRole("button", { name: "Новое сообщение" }));
  expect(screen.getByRole("textbox")).toHaveValue(""); expect(screen.getByRole("textbox")).toBeEnabled();
});

it("preserves and freezes text after comment failure; retries the same report without resending telemetry", async () => {
  boundary.send.mockResolvedValue({ reportId, breadcrumbCount: 3, truncated: false });
  boundary.post.mockRejectedValueOnce(new Error("RAW_PRIVATE_QUERY_VALUE"));
  render(<ReportProblemButton />); open();
  fireEvent.change(await screen.findByRole("textbox"), { target: { value: "Мой исходный текст" } });
  fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert")).toHaveTextContent("Отчёт принят");
  expect(screen.getByRole("textbox")).toHaveValue("Мой исходный текст"); expect(screen.getByRole("textbox")).toBeDisabled();
  expect(screen.queryByText(/RAW_PRIVATE/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" }));
  await screen.findByText("Отчёт отправлен");
  expect(boundary.send).toHaveBeenCalledTimes(1);
  expect(boundary.post.mock.calls).toEqual(Array(2).fill([`/api/problem-reports/${reportId}/comment`, { comment: "Мой исходный текст" }]));
});

it("does not post a prior actor's text after a late diagnostic ACK", async () => {
  const ack = deferred<{ reportId: string; breadcrumbCount: number; truncated: boolean }>(); boundary.send.mockReturnValue(ack.promise);
  const view = render(<ReportProblemButton />); open();
  fireEvent.change(await screen.findByRole("textbox"), { target: { value: "Private actor A text" } });
  fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
  boundary.actor = "actor-B"; view.rerender(<ReportProblemButton />);
  await act(async () => ack.resolve({ reportId, breadcrumbCount: 3, truncated: false }));
  expect(boundary.post).not.toHaveBeenCalled();
  open(); expect(await screen.findByRole("textbox")).toHaveValue("");
});

it("starts a fresh editable intent only on explicit choice after a failed send", async () => {
  const nextId = "22222222-2222-4222-8222-222222222222";
  boundary.prepare.mockImplementationOnce((reason, screen) => Object.freeze({ reportId, reason, screen, breadcrumbCount: 3, truncated: false }))
    .mockImplementationOnce((reason, screen) => Object.freeze({ reportId: nextId, reason, screen, breadcrumbCount: 2, truncated: false }));
  boundary.send.mockRejectedValueOnce(new Error("not confirmed"));
  const ack = deferred<{ reportId: string; breadcrumbCount: number; truncated: boolean }>();
  boundary.send.mockReturnValueOnce(ack.promise);
  render(<ReportProblemButton />); open();
  fireEvent.click(await screen.findByRole("button", { name: "Отправить сообщение" }));
  await screen.findByRole("alert");
  const oldDraft = boundary.send.mock.calls[0][0];
  expect(screen.getByRole("radio", { name: "Не работает кнопка или действие" })).toBeDisabled();
  expect(screen.getByText(/Предыдущая попытка могла сохраниться/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Начать новое сообщение" }));
  expect(screen.getByRole("radio", { name: "Не работает кнопка или действие" })).toBeEnabled();
  fireEvent.click(screen.getByRole("radio", { name: "Не работает кнопка или действие" }));
  fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
  expect(boundary.prepare).toHaveBeenLastCalledWith("button", "my-tasks");
  expect(boundary.send.mock.calls[1][0]).not.toBe(oldDraft);
  expect(boundary.send.mock.calls[1][0].reportId).toBe(nextId);
  expect(screen.queryByRole("button", { name: "Начать новое сообщение" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Отправляем…" })).toBeDisabled();
  await act(async () => ack.resolve({ reportId: nextId, breadcrumbCount: 2, truncated: false }));
  expect(screen.getByText(nextId)).toBeInTheDocument();
  expect(screen.queryByText(reportId)).not.toBeInTheDocument();
});
it("does not allow starting a fresh intent while an acknowledgement is pending", async () => {
  const ack = deferred<{ reportId: string; breadcrumbCount: number; truncated: boolean }>(); boundary.send.mockReturnValue(ack.promise);
  render(<ReportProblemButton />); open(); fireEvent.click(await screen.findByRole("button", { name: "Отправить сообщение" }));
  expect(screen.queryByRole("button", { name: "Начать новое сообщение" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Закрыть окно" })); open();
  expect(await screen.findByRole("button", { name: "Отправляем…" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Начать новое сообщение" })).not.toBeInTheDocument();
  await act(async () => ack.resolve({ reportId, breadcrumbCount: 3, truncated: true }));
  expect(boundary.prepare).toHaveBeenCalledTimes(1); expect(boundary.send).toHaveBeenCalledTimes(1);
  expect(screen.getByText(reportId)).toBeInTheDocument();
});

it("ignores a prior session's late ACK after explicitly starting a new report", async () => {
  const oldAck = deferred<{ reportId: string; breadcrumbCount: number; truncated: boolean }>();
  const newAck = deferred<{ reportId: string; breadcrumbCount: number; truncated: boolean }>();
  const nextId = "33333333-3333-4333-8333-333333333333";
  boundary.send.mockReturnValueOnce(oldAck.promise).mockReturnValueOnce(newAck.promise);
  boundary.prepare.mockImplementationOnce((reason, screen) => ({ reportId, reason, screen, breadcrumbCount: 3, truncated: false }))
    .mockImplementationOnce((reason, screen) => ({ reportId: nextId, reason, screen, breadcrumbCount: 1, truncated: false }));
  render(<ReportProblemButton />); open(); fireEvent.click(await screen.findByRole("button", { name: "Отправить сообщение" }));
  act(() => boundary.listeners.forEach(callback => callback()));
  fireEvent.click(await screen.findByRole("button", { name: "Начать новое сообщение" }));
  fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
  await act(async () => oldAck.resolve({ reportId, breadcrumbCount: 3, truncated: false }));
  expect(screen.queryByText("Отчёт отправлен")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Отправляем…" })).toBeDisabled();
  await act(async () => newAck.resolve({ reportId: nextId, breadcrumbCount: 1, truncated: false }));
  expect(screen.getByText(nextId)).toBeInTheDocument(); expect(screen.queryByText(reportId)).not.toBeInTheDocument();
});
