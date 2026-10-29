import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskAttachments } from "./TaskAttachments";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const uploaded = {
  url: "/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f",
  name: "report.pdf",
  size: 12,
  mime: "application/pdf",
};

function setup(attachments: { url: string; name: string; size: number; mime: string }[] = []) {
  const onUpdate = vi.fn();
  const view = render(<TaskAttachments canUpload canRemove version={7} taskId="task" attachments={attachments} onUpdate={onUpdate} />);
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
  return { onUpdate, input, view };
}

beforeEach(() => { apiFetch.mockReset(); });
afterEach(() => { cleanup(); });

describe("TaskAttachments upload", () => {
  it("posts multipart data to the direct upload endpoint and applies the returned list", async () => {
    apiFetch.mockResolvedValue({ uploaded: [uploaded], count: 1 });
    const { onUpdate, input } = setup();
    const file = new File([Uint8Array.from([1, 2, 3])], "report.pdf", { type: "application/pdf" });

    await userEvent.upload(input, file);

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe("/api/uploads/direct");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("taskId")).toBe("task");
    expect(form.getAll("files")).toHaveLength(1);
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith([uploaded]));
  });

  it("shows the sanitized server error and does not update the list", async () => {
    apiFetch.mockRejectedValue(Object.assign(new Error("Недопустимый формат или размер файла"), { status: 422 }));
    const { onUpdate, input } = setup();
    await userEvent.upload(input, new File([Uint8Array.from([1])], "report.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(screen.getByText("Недопустимый формат или размер файла")).toBeTruthy());
    expect(screen.getByRole("alert")).toHaveTextContent("Недопустимый формат или размер файла");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("keeps a refused upload visible until another attempt succeeds", async () => {
    apiFetch.mockRejectedValueOnce(Object.assign(new Error("Недопустимый формат или размер файла"), { status: 422 }));
    const { onUpdate, input } = setup();
    const file = new File([Uint8Array.from([1])], "report.pdf", { type: "application/pdf" });
    await userEvent.upload(input, file);
    expect(await screen.findByRole("alert")).toHaveTextContent("Недопустимый формат или размер файла");
    apiFetch.mockResolvedValueOnce({ uploaded: [uploaded], count: 1 });
    await userEvent.upload(input, file);
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith([uploaded]));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rejects more than five selected files before any request", async () => {
    const { input } = setup();
    const files = Array.from({ length: 6 }, (_, index) =>
      new File([Uint8Array.from([1])], `file${index}.pdf`, { type: "application/pdf" }));

    await userEvent.upload(input, files);

    expect(await screen.findByText("Можно загрузить не более 5 файлов за раз")).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects a file above 25 MB before any request", async () => {
    const { input } = setup();
    const file = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" });

    await userEvent.upload(input, file);

    expect(await screen.findByText("Файл больше 25 МБ")).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("removes an attachment through a versioned detach command", async () => {
    const existing = { url: "/legacy/file", name: "old.txt", size: 3, mime: "text/plain" };
    apiFetch.mockResolvedValue({ taskId: "task", version: 8 });
    const { onUpdate, view } = setup([existing]);

    await userEvent.click(screen.getByRole("button", { name: "Удалить вложение: old.txt" }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/tasks/task/attachments", expect.objectContaining({ method: "DELETE" })));
    expect(onUpdate).toHaveBeenCalledWith([]);
    // The list is controlled by the parent; it disappears once the parent applies the update.
    view.rerender(<TaskAttachments canUpload canRemove version={7} taskId="task" attachments={[]} onUpdate={onUpdate} />);
    expect(view.container.textContent).not.toContain("old.txt");
  });

  it("keeps the documented format and size hints visible", () => {
    setup();
    expect(screen.getByText("До 25 МБ на файл · до 5 файлов · 50 МБ за раз")).toBeTruthy();
    expect(screen.getByText("Фото, PDF, DOCX, XLSX, PPTX")).toBeTruthy();
  });
});

describe("TaskAttachments at 320px", () => {
  const longName = "протокол-встречи-по-интеграции-с-очень-длинным-именем-файла-версия-2026-10-21.pdf";
  const longUrl = `https://files.example.invalid/${"a".repeat(180)}/report.pdf`;

  it("wraps long file names and URLs instead of widening the panel", () => {
    const { view } = setup([{ url: longUrl, name: longName, size: 2048, mime: "application/pdf" }]);

    const link = screen.getByRole("link", { name: longName });
    expect(link).toHaveClass("block", "[overflow-wrap:anywhere]");
    expect(link).toHaveAttribute("href", longUrl);
    expect(link).toHaveAttribute("title", longName);

    const row = link.closest("div.flex") as HTMLElement;
    expect(row).toHaveClass("min-w-0", "flex-wrap");
    const textColumn = link.parentElement as HTMLElement;
    expect(textColumn).toHaveClass("flex-1", "min-w-0", "basis-24");

    // The attachment grid collapses to one column below its 15rem track.
    const grid = view.container.querySelector(".grid.min-w-0.grid-cols-\\[repeat\\(auto-fit\\,minmax\\(min\\(100\\%\\,15rem\\)\\,1fr\\)\\)\\]");
    expect(grid).not.toBeNull();
    expect(grid).toHaveClass("min-w-0");
  });

  it("wraps long image names and keeps the remove control touch-sized", () => {
    setup([{ url: "/api/tasks/task/files/image", name: longName, size: 512, mime: "image/png" }]);

    const name = screen.getByText(longName);
    expect(name).toHaveClass("min-w-0", "flex-1", "[overflow-wrap:anywhere]");

    const remove = screen.getByRole("button", { name: `Удалить вложение: ${longName}` });
    expect(remove).toHaveClass("h-9", "w-9", "[@media(hover:none)]:opacity-100");
    expect(remove).toHaveAttribute("title", "Удалить");

    const download = screen.queryByRole("link", { name: `Скачать вложение: ${longName}` });
    expect(download).toBeNull();
  });

  it("keeps the upload area free of fixed width and horizontal overflow", () => {
    const { view } = setup();
    const dropZone = view.container.querySelector(".border-dashed") as HTMLElement;
    expect(dropZone).toHaveClass("rounded-lg", "border-2", "p-4");
    expect(dropZone.className).not.toContain("w-[");
    expect(dropZone.className).not.toContain("whitespace-nowrap");
    expect(screen.getByRole("button", { name: "выберите" })).toBeInTheDocument();
    expect(view.container.querySelector('input[type="file"]')).toHaveClass("hidden");
  });
});
