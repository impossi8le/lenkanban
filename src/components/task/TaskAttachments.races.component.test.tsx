import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ upload: vi.fn(), request: vi.fn() }));
vi.mock("./TaskFormAttachments", () => ({ uploadTaskAttachments: api.upload }));
vi.mock("@/lib/api", () => ({ apiFetch: api.request }));
import { TaskAttachments } from "./TaskAttachments";
const file = { url: "/api/tasks/first/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f", name: "own.pdf", mime: "application/pdf", size: 10 };
const other = { ...file, url: "/api/tasks/first/files/1a6e3b9e-3dcb-402e-891a-d1074b75d40f", name: "colleague.pdf" };
function pending() { let resolve!: (files: typeof file[]) => void; const promise = new Promise<typeof file[]>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.resetAllMocks(); }); afterEach(cleanup);
it("does not apply a previous task's upload completion to the newly opened card", async () => {
  const response = pending(); api.upload.mockReturnValue(response.promise); const update = vi.fn();
  const view = render(<TaskAttachments canUpload taskId="first" attachments={[]} onUpdate={update}/>);
  await userEvent.upload(view.container.querySelector('input[type="file"]')!, new File(["pdf"], "own.pdf", { type: "application/pdf" }));
  view.rerender(<TaskAttachments canUpload taskId="second" attachments={[]} onUpdate={update}/>);
  await act(async () => { response.resolve([file]); await response.promise; }); expect(update).not.toHaveBeenCalled();
  expect(screen.queryByText(/Загружено/)).not.toBeInTheDocument();
});
it("merges a confirmed upload with the latest server files without losing concurrent additions or duplicating its echo", async () => {
  const response = pending(); api.upload.mockReturnValue(response.promise); const update = vi.fn();
  const view = render(<TaskAttachments canUpload taskId="first" attachments={[]} onUpdate={update}/>);
  await userEvent.upload(view.container.querySelector('input[type="file"]')!, new File(["pdf"], "own.pdf", { type: "application/pdf" }));
  view.rerender(<TaskAttachments canUpload taskId="first" attachments={[other, file]} onUpdate={update}/>);
  await act(async () => { response.resolve([file]); await response.promise; }); expect(update).toHaveBeenCalledWith([other, file]);
});
it("does not change parent state when an upload resolves after the panel unmounts", async () => {
  const response = pending(); api.upload.mockReturnValue(response.promise); const update = vi.fn();
  const view = render(<TaskAttachments canUpload taskId="first" attachments={[]} onUpdate={update}/>);
  await userEvent.upload(view.container.querySelector('input[type="file"]')!, new File(["pdf"], "own.pdf", { type: "application/pdf" })); view.unmount();
  await act(async () => { response.resolve([file]); await response.promise; }); expect(update).not.toHaveBeenCalled();
});
