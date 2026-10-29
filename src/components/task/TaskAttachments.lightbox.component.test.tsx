import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { TaskAttachments } from "./TaskAttachments";

const longName = "скан-договора-с-очень-длинным-именем-файла-версия-2026-10-21.png";

beforeEach(() => {
  apiFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

it("sizes the image lightbox by the dynamic viewport so the on-screen keyboard cannot clip it", async () => {
  render(
    <TaskAttachments
      taskId="task"
      attachments={[{ url: "/api/tasks/task/files/image", name: longName, size: 512, mime: "image/png" }]}
      onUpdate={vi.fn()}
    />
  );

  await userEvent.click(screen.getByRole("button", { name: `Открыть изображение: ${longName}` }));

  const image = screen.getByRole("img", { name: longName });
  // 85vh is measured against the largest viewport (URL bar/keyboard hidden);
  // with the keyboard open the lightbox would overflow the visible area.
  expect(image).toHaveClass("max-h-[85dvh]");
  expect(image).not.toHaveClass("max-h-[85vh]");
  expect(image).toHaveClass("max-w-full", "min-w-0", "object-contain");

  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveClass("w-[calc(100vw-2rem)]", "max-w-[900px]", "min-w-0", "overflow-hidden");
  expect(dialog).toHaveClass("max-h-[calc(100dvh-2rem)]");
});


it("ignores malformed attachment JSON while retaining valid files", () => {
  render(<TaskAttachments taskId="task" attachments={[null, { url: "/bad", name: "bad", size: 2 },
    { url: "/good", name: "good.pdf", size: 10, mime: "application/pdf" }] as never} onUpdate={vi.fn()} />);
  expect(screen.getByText("good.pdf")).toBeInTheDocument();
  expect(screen.queryByText("bad")).toBeNull();
});
