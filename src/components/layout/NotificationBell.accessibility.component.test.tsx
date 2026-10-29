import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "./notification-bell";

const { api, push } = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: api }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "user-1" } }, status: "authenticated" }) }));
vi.mock("@/hooks/useNotificationSocket", () => ({ useNotificationSocket: () => ({ socket: null }) }));

const notification = {
  id: "synthetic-notice", type: "TASK_ASSIGNED", title: "Синтетическое уведомление",
  message: "Описание для проверки", read: false, readAt: null,
  actionUrl: null, metadata: null, createdAt: "2026-10-21T09:00:00.000Z",
};
const clients: QueryClient[] = [];
const unreadSummary = (count: number) => ({ actorId: "user-1", count, byProject: { "project-1": count }, byTask: { "task-1": count }, unscopedCount: 0 });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><NotificationBell /></QueryClientProvider>);
}
async function openBell() {
  await screen.findByText("1");
  const trigger = screen.getByRole("button", { name: "Уведомления" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Уведомления" });
  return { trigger, dialog };
}

const longNotification = {
  ...notification,
  id: "synthetic-long-notice",
  title: `Синтетический${"ЗаголовокБезПробелов".repeat(12)}`,
  message: `https://example.invalid/${"a".repeat(240)}`,
};

// Read the actual viewport-bound declaration from the rendered class list and
// evaluate its CSS min() for the emulated width. jsdom has no layout engine, so
// this guards the width contract rather than measuring a box.
function declaredPopoverWidth(className: string, viewport: number) {
  const match = /(?:^|\s)w-\[min\((\d+)px,calc\(100vw-([\d.]+)rem\)\)\](?:\s|$)/.exec(className);
  if (!match) throw new Error("The notification popover must declare a viewport-bound width");
  return Math.min(Number(match[1]), viewport - Number(match[2]) * 16);
}

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (url: string) => url.endsWith("unread-count") ? unreadSummary(1) : [notification]);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
});

describe("NotificationBell accessibility", () => {
  it("names the real Radix dialog with its visible heading", async () => {
    mount();
    const { trigger, dialog } = await openBell();
    const heading = within(dialog).getByRole("heading", { name: "Уведомления" });
    expect(dialog).toHaveAttribute("aria-labelledby", heading.id);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(await within(dialog).findByRole("button", { name: /Синтетическое уведомление/ })).toBeVisible();
  });

  it("keeps mark-all accessible and sends only one PATCH while pending", async () => {
    let release!: () => void;
    let unread = true;
    const pending = new Promise<void>(resolve => { release = resolve; });
    api.mockImplementation(async (url: string) => {
      if (url === "/api/notifications/unread-count") return unreadSummary(unread ? 1 : 0);
      if (url === "/api/notifications/mark-all-read") {
        await pending;
        unread = false;
        return null;
      }
      return [{ ...notification, read: !unread }];
    });
    mount();
    const { dialog } = await openBell();
    const markAll = within(dialog).getByRole("button", { name: "Прочитать все" });
    await waitFor(() => expect(markAll).toHaveFocus());
    fireEvent.click(markAll);
    await waitFor(() => expect(markAll).toBeDisabled());
    fireEvent.click(markAll);
    fireEvent.click(markAll);
    expect(api.mock.calls.filter(([url]) => url === "/api/notifications/mark-all-read"))
      .toEqual([["/api/notifications/mark-all-read", { method: "PATCH" }]]);
    await act(async () => { release(); await pending; });
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Прочитать все" })).not.toBeInTheDocument());
  });

  it("dismisses with Escape and restores focus to the trigger", async () => {
    mount();
    const { trigger, dialog } = await openBell();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Прочитать все" })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Уведомления" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it.each([320, 360])(
    "keeps a long notification and its mark-all action inside a %ipx viewport",
    async (width) => {
      const originalWidth = window.innerWidth;
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      try {
        api.mockImplementation(async (url: string) =>
          url.endsWith("unread-count") ? unreadSummary(1) : [longNotification]);
        mount();
        const { dialog } = await openBell();

        const declaredWidth = declaredPopoverWidth(dialog.className, width);
        expect(declaredWidth).toBeGreaterThan(0);
        expect(declaredWidth).toBeLessThanOrEqual(width - 16);
        expect(dialog.className).not.toMatch(/(^|\s)w-\[380px\](\s|$)/);
        expect(dialog.className).not.toMatch(/(^|\s)w-72(\s|$)/);
        expect(dialog.className).toContain("overflow-hidden");
        expect(dialog.className).toContain("max-h-[var(--radix-popover-content-available-height)]");

        const title = await within(dialog).findByText(longNotification.title);
        expect(title.className).toContain("break-words");
        expect(title.closest(".min-w-0")).not.toBeNull();
        const message = within(dialog).getByText(longNotification.message);
        expect(message.className).toContain("break-words");
        expect(message.className).toContain("line-clamp-2");
        const scrollArea = message.closest(".overflow-y-auto");
        expect(scrollArea).not.toBeNull();
        expect(scrollArea!.className).toContain("overscroll-contain");
        expect(scrollArea!.className).not.toMatch(/overflow-x-(auto|scroll)/);

        const markAll = within(dialog).getByRole("button", { name: "Прочитать все" });
        expect(markAll).toBeVisible();
        expect(markAll).toBeEnabled();
        markAll.focus();
        expect(markAll).toHaveFocus();

        const results = await axe(dialog);
        expect(
          results.violations.filter((violation) =>
            violation.impact === "serious" || violation.impact === "critical"),
        ).toEqual([]);
      } finally {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      }
    },
  );
});
