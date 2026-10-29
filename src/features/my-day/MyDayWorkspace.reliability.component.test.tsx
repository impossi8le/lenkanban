import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MyDayEntry } from "@/lib/my-day-contract";

const transport = vi.hoisted(() => ({ request: vi.fn(), replace: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: transport.request }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/my-day",
  useSearchParams: () => new URLSearchParams("date=2026-10-29"),
  useRouter: () => ({ replace: transport.replace }),
}));

import { MyDayWorkspace } from "./MyDayWorkspace";
import { reconcileMyDaySessionDrafts } from "./my-day-draft";

const date = "2026-10-29";
const originalText = "Согласовал утренние обращения.";
const intermediateText = "Согласовал утренние обращения. Проверил счета.";
const finalText = "Согласовал утренние обращения. Завершил работу со счетами.";
type SavedEntry = MyDayEntry & { operationId?: string };
let server: SavedEntry;
let loseNextAcknowledgement: boolean;

function dto(entry = server): MyDayEntry {
  return { date: entry.date, text: entry.text, version: entry.version, updatedAt: entry.updatedAt, today: entry.today };
}

function emulateServer() {
  transport.request.mockImplementation(async (path: string, options?: RequestInit) => {
    const selectedDate = new URL(path, "http://synthetic.invalid").searchParams.get("date")!;
    if (options?.method !== "PUT") {
      return selectedDate === date ? dto() : { date: selectedDate, text: "", version: 0, updatedAt: null, today: date };
    }
    const input = JSON.parse(options.body as string) as { text: string; expectedVersion: number; operationId: string };
    if (server.operationId === input.operationId && server.version === input.expectedVersion + 1 && server.text === input.text) {
      return dto();
    }
    if (input.expectedVersion !== server.version) {
      throw Object.assign(new Error("Запись изменена в другом окне."), {
        status: 409,
        payload: { success: false, error: { code: "CONFLICT", details: { current: dto() } } },
      });
    }
    server = { ...server, text: input.text, version: server.version + 1, operationId: input.operationId };
    if (loseNextAcknowledgement) {
      loseNextAcknowledgement = false;
      throw new TypeError("Synthetic lost response after database commit");
    }
    return dto();
  });
}

async function openDiary() {
  const view = render(<MyDayWorkspace actorId="synthetic-alice" />);
  await act(async () => {});
  expect(screen.getByRole("textbox", { name: "Что я сделал за день" })).toBeEnabled();
  return view;
}

function type(text: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Что я сделал за день" }), { target: { value: text } });
}

async function autosave() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  sessionStorage.clear();
  reconcileMyDaySessionDrafts(null, "unauthenticated");
  vi.clearAllMocks();
  server = { date, text: originalText, version: 1, updatedAt: "2026-10-29T12:00:00Z", today: date };
  loseNextAcknowledgement = false;
  emulateServer();
});

afterEach(() => {
  cleanup();
  reconcileMyDaySessionDrafts(null, "unauthenticated");
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("diary autosave reliability at the real UI boundary", () => {
  it("persists a return to the original text after an earlier save committed but its acknowledgement was lost", async () => {
    await openDiary();
    loseNextAcknowledgement = true;
    type(intermediateText);
    await autosave();
    expect(server.text).toBe(intermediateText);
    expect(screen.getByText("Ошибка сохранения")).toBeVisible();

    type(originalText);
    await autosave();

    // The latest user intent must reach persistence, even though it matches the
    // last text acknowledged BEFORE the lost response.
    expect(server.text).toBe(originalText);
    expect(screen.queryByRole("alert", { name: "Конфликт версий дневника" })).not.toBeInTheDocument();
  });

  it("settles an uncertain save before saving newer typing, without inventing a two-window conflict", async () => {
    await openDiary();
    loseNextAcknowledgement = true;
    type(intermediateText);
    await autosave();
    expect(screen.getByText("Ошибка сохранения")).toBeVisible();

    type(finalText);
    await autosave();

    expect(server.text).toBe(finalText);
    expect(screen.queryByRole("alert", { name: "Конфликт версий дневника" })).not.toBeInTheDocument();
  });

  it("flushes an uncertain save and the latest reverted text before changing the selected day", async () => {
    await openDiary();
    loseNextAcknowledgement = true;
    type(intermediateText);
    await autosave();
    expect(screen.getByText("Ошибка сохранения")).toBeVisible();

    type(originalText);
    fireEvent.click(screen.getByRole("button", { name: "Предыдущий день" }));
    await act(async () => {});

    expect(server.text).toBe(originalText);
    expect(screen.getByRole("heading", { name: /28 октября 2026/ })).toBeVisible();
  });

  it("keeps a two-window conflict unresolved after reload until the employee explicitly chooses a version", async () => {
    const firstMount = await openDiary();
    server = { ...server, text: "Изменения из другого окна.", version: 2, operationId: "external-operation" };
    type(finalText);
    await autosave();
    expect(screen.getByRole("alert", { name: "Конфликт версий дневника" })).toBeVisible();
    expect(server.text).toBe("Изменения из другого окна.");
    const continuedDraft = `${finalText}\nДополнил итог после предупреждения о конфликте.`;
    type(continuedDraft);

    firstMount.unmount();
    await openDiary();
    await autosave();

    expect(screen.getByRole("textbox", { name: "Что я сделал за день" })).toHaveValue(continuedDraft);
    expect(server.text).toBe("Изменения из другого окна.");
    expect(server.version).toBe(2);
    expect(screen.getByRole("alert", { name: "Конфликт версий дневника" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Сохранить мой вариант" }));
    await act(async () => {});
    expect(server.text).toBe(continuedDraft);
    expect(server.version).toBe(3);
    expect(screen.queryByRole("alert", { name: "Конфликт версий дневника" })).not.toBeInTheDocument();
  });
});
