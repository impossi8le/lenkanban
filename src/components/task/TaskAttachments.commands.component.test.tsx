import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ upload: vi.fn(), request: vi.fn() }));
vi.mock("./TaskFormAttachments", () => ({ uploadTaskAttachments: api.upload }));
vi.mock("@/lib/api", () => ({ apiFetch: api.request }));
import { TaskAttachments } from "./TaskAttachments";
const file = { url: "/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f", name: "File.pdf", size: 10, mime: "application/pdf" };
beforeEach(() => vi.resetAllMocks()); afterEach(cleanup);
it("uses one frozen versioned detach and refreshes only after the ACK", async () => {
  const update = vi.fn(), refresh = vi.fn(); api.request.mockResolvedValue({ taskId: "task", version: 8 });
  render(<TaskAttachments taskId="task" version={7} marked canRemove attachments={[file]} onUpdate={update} onCommitted={refresh}/>);
  await userEvent.click(screen.getByRole("button", { name: "Удалить вложение: File.pdf" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith([])); expect(refresh).toHaveBeenCalledOnce();
  expect(api.request.mock.calls[0][1].method).toBe("DELETE"); expect(JSON.parse(api.request.mock.calls[0][1].body)).toEqual({ operationId: expect.any(String), expectedVersion: 7, url: file.url });
});
it("keeps an immutable published attachment visible with a clear explanation", async () => {
  const update = vi.fn(); api.request.mockRejectedValue({ status: 422, payload: { error: { code: "ATTACHMENT_IN_MESSAGE" } } });
  render(<TaskAttachments taskId="task" version={7} canRemove attachments={[file]} onUpdate={update}/>);
  await userEvent.click(screen.getByRole("button", { name: "Удалить вложение: File.pdf" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Этот файл опубликован в сообщении"); expect(update).not.toHaveBeenCalled(); expect(screen.getByText("File.pdf")).toBeInTheDocument();
});
it("retries only the same uncertain command and blocks a second intent", async () => {
  api.request.mockRejectedValueOnce(Error("network")).mockResolvedValueOnce({ taskId: "task", version: 8 }); const update = vi.fn();
  render(<TaskAttachments taskId="task" version={7} canRemove attachments={[file]} onUpdate={update}/>);
  await userEvent.click(screen.getByRole("button", { name: "Удалить вложение: File.pdf" })); await screen.findByRole("button", { name: "Повторить удаление" });
  expect(update).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Удалить вложение: File.pdf" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Повторить удаление" })); await waitFor(() => expect(update).toHaveBeenCalledWith([]));
  expect(api.request.mock.calls[1][1].body).toBe(api.request.mock.calls[0][1].body);
});
it("does not offer original upload/removal to a read-only observer", () => {
  const view = render(<TaskAttachments taskId="task" version={7} attachments={[file]} onUpdate={vi.fn()}/>);
  expect(screen.queryByRole("button", { name: "выберите" })).not.toBeInTheDocument(); expect(view.container.querySelector('input[type="file"]')).toBeNull();
  expect(screen.queryByRole("button", { name: "Удалить вложение: File.pdf" })).not.toBeInTheDocument(); expect(screen.getByText("File.pdf")).toBeInTheDocument();
});
it("holds attachment actions until the authoritative version catches up with a committed canonical upload", async () => {
  api.upload.mockResolvedValue([file]); const update = vi.fn(), refresh = vi.fn(async () => undefined);
  const view = render(<TaskAttachments taskId="task" version={7} marked canUpload canRemove attachments={[file]} onUpdate={update} onCommitted={refresh}/>);
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["pdf"], "File.pdf", { type: "application/pdf" })] } });
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "Удалить вложение: File.pdf" })).toBeDisabled(); expect(screen.getByRole("button", { name: "выберите" })).toBeDisabled();
  await act(async () => view.rerender(<TaskAttachments taskId="task" version={8} marked canUpload canRemove attachments={[file]} onUpdate={update} onCommitted={refresh}/>));
  expect(screen.getByRole("button", { name: "Удалить вложение: File.pdf" })).toBeEnabled();
});

it("keeps valid files renderable when old asset JSON contains invalid types and dimensions", () => {
  render(<TaskAttachments taskId="task" attachments={[null, [], "bad", { ...file, name: { text: "bad" } }, { ...file, mime: null }, { ...file, size: Infinity }, { ...file, width: Infinity, height: -5 }] as never} onUpdate={vi.fn()}/>);
  expect(screen.getByText("File.pdf")).toBeInTheDocument(); expect(screen.queryByText("bad")).not.toBeInTheDocument();
});
