import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MyDayPage from "@/app/(dashboard)/my-day/page";
import { getMyDayDraftKey } from "./my-day-draft";
import type { MyDayEntry } from "./my-day-dates";

const runtime = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  replace: vi.fn(),
  pathname: "/my-day",
  search: "",
  session: {
    data: { user: { id: "actor-1", name: "Мотин Даниил", email: "motin@example.test" } } as {
      user?: { id?: string; name?: string; email?: string };
    } | null,
    status: "authenticated" as "loading" | "authenticated" | "unauthenticated",
  },
}));

vi.mock("@/lib/api", () => ({
  apiFetch: runtime.apiFetch,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: runtime.replace, push: vi.fn() }),
  usePathname: () => runtime.pathname,
  useSearchParams: () => new URLSearchParams(runtime.search),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => runtime.session,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useRealTimers();
  window.sessionStorage.clear();
  runtime.apiFetch.mockReset();
  runtime.replace.mockReset();
  runtime.pathname = "/my-day";
  runtime.search = "date=2026-10-29";
  runtime.session = {
    data: { user: { id: "actor-1", name: "Мотин Даниил", email: "motin@example.test" } },
    status: "authenticated",
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MyDayPage & MyDayWorkspace", () => {
  it("keeps the editor disabled until GET finishes, uses 18px text and 44px+ calendar cells, and toggles mobile calendar", async () => {
    const getPending = deferred<MyDayEntry>();
    runtime.apiFetch.mockImplementationOnce(() => getPending.promise);

    render(<MyDayPage />);

    const editor = screen.getByLabelText("Что я сделал за день") as HTMLTextAreaElement;
    expect(editor).toBeDisabled();
    expect(editor).toHaveClass("text-[18px]");
    expect(screen.getByText("Загрузка записи…")).toBeInTheDocument();

    const mobileToggle = screen.getByRole("button", { name: /Выбрать дату:/i });
    expect(mobileToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(mobileToggle);
    expect(mobileToggle).toHaveAttribute("aria-expanded", "true");

    await act(async () => {
      getPending.resolve({
        date: "2026-10-29",
        text: "Разобрал утренние обращения.",
        version: 1,
        updatedAt: "2026-10-29T08:00:00.000Z",
        today: "2026-10-29",
      });
      await getPending.promise;
    });

    await waitFor(() => expect(editor).not.toBeDisabled());
    expect(editor.value).toBe("Разобрал утренние обращения.");
    expect(screen.getByText(/^(Сохранено в \d{2}:\d{2}|Все изменения сохранены)$/)).toBeInTheDocument();

    // Verify 44px+ (h-11 w-11 min-h-11 min-w-11) override on calendar day buttons
    const calendarPanel = screen.getAllByLabelText("Календарь выбора дня")[0];
    const dayButtons = calendarPanel.querySelectorAll("td button");
    expect(dayButtons.length).toBeGreaterThan(20);
    for (const btn of dayButtons) {
      expect(btn).toHaveClass("min-h-11", "min-w-11", "h-11", "w-11");
    }
  });

  it("debounces autosave by 1000ms, serializes in-flight PUT requests, and clears sessionStorage draft only when exact text is confirmed", async () => {
    const firstPut = deferred<MyDayEntry>();
    const secondPut = deferred<MyDayEntry>();

    runtime.apiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return Promise.resolve({
          date: "2026-10-29",
          text: "",
          version: 0,
          updatedAt: null,
          today: "2026-10-29",
        });
      }
      const body = JSON.parse(String(init.body));
      if (body.text === "Первая строка") return firstPut.promise;
      if (body.text === "Первая строка\nВторая строка") return secondPut.promise;
      throw new Error(`Unexpected PUT body: ${init.body}`);
    });

    render(<MyDayPage />);
    const editor = await screen.findByLabelText("Что я сделал за день");
    await waitFor(() => expect(editor).not.toBeDisabled());

    vi.useFakeTimers();

    fireEvent.change(editor, { target: { value: "Первая строка" } });

    const draftKey = getMyDayDraftKey("actor-1", "2026-10-29");
    expect(JSON.parse(window.sessionStorage.getItem(draftKey)!)).toEqual({
      actorId: "actor-1",
      date: "2026-10-29",
      text: "Первая строка",
      baseVersion: 0,
    });

    // Not sent before 1000ms
    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    expect(runtime.apiFetch).toHaveBeenCalledTimes(1);

    // Sent at 1000ms
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(runtime.apiFetch).toHaveBeenCalledTimes(2);
    const firstPutCall = runtime.apiFetch.mock.calls[1];
    const firstPayload = JSON.parse(firstPutCall[1].body);
    expect(firstPayload.text).toBe("Первая строка");
    expect(firstPayload.expectedVersion).toBe(0);
    expect(firstPayload.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    // User types while first PUT is still in flight
    fireEvent.change(editor, { target: { value: "Первая строка\nВторая строка" } });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    // Still only 1 PUT in flight!
    expect(runtime.apiFetch).toHaveBeenCalledTimes(2);

    // Resolve first PUT: draft must NOT be deleted because editor has newer text; second PUT must start immediately
    await act(async () => {
      firstPut.resolve({
        date: "2026-10-29",
        text: "Первая строка",
        version: 1,
        updatedAt: "2026-10-29T09:00:00.000Z",
        today: "2026-10-29",
      });
      await firstPut.promise;
    });

    expect(JSON.parse(window.sessionStorage.getItem(draftKey)!)).toEqual({
      actorId: "actor-1",
      date: "2026-10-29",
      text: "Первая строка\nВторая строка",
      baseVersion: 1,
    });

    expect(runtime.apiFetch).toHaveBeenCalledTimes(3);
    const secondPayload = JSON.parse(runtime.apiFetch.mock.calls[2][1].body);
    expect(secondPayload.text).toBe("Первая строка\nВторая строка");
    expect(secondPayload.expectedVersion).toBe(1);
    expect(secondPayload.operationId).not.toBe(firstPayload.operationId);

    // Resolve second PUT: now exact text is confirmed, so sessionStorage draft is removed
    await act(async () => {
      secondPut.resolve({
        date: "2026-10-29",
        text: "Первая строка\nВторая строка",
        version: 2,
        updatedAt: "2026-10-29T09:00:02.000Z",
        today: "2026-10-29",
      });
      await secondPut.promise;
    });

    expect(window.sessionStorage.getItem(draftKey)).toBeNull();
    expect(screen.getByText(/^(Сохранено в \d{2}:\d{2}|Все изменения сохранены)$/)).toBeInTheDocument();
  });

  it("retries the exact same PUT payload (same operationId and expectedVersion) after a network failure", async () => {
    let putAttempts = 0;
    runtime.apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return {
          date: "2026-10-29",
          text: "Исходный",
          version: 3,
          updatedAt: "2026-10-29T08:00:00.000Z",
          today: "2026-10-29",
        };
      }
      putAttempts += 1;
      if (putAttempts === 1) {
        throw new Error("Сетевой сбой сохранения");
      }
      const parsed = JSON.parse(String(init.body));
      return {
        date: "2026-10-29",
        text: parsed.text,
        version: parsed.expectedVersion + 1,
        updatedAt: "2026-10-29T09:05:00.000Z",
        today: "2026-10-29",
      };
    });

    render(<MyDayPage />);
    const editor = await screen.findByLabelText("Что я сделал за день");
    await waitFor(() => expect(editor).not.toBeDisabled());

    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Исходный + дополнение" } });

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    vi.useRealTimers();

    expect(await screen.findByText("Сетевой сбой сохранения")).toBeInTheDocument();
    const firstAttemptBody = JSON.parse(runtime.apiFetch.mock.calls[1][1].body);

    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    await waitFor(() => expect(screen.getByText(/^(Сохранено в \d{2}:\d{2}|Все изменения сохранены)$/)).toBeInTheDocument());
    expect(runtime.apiFetch).toHaveBeenCalledTimes(3);
    const secondAttemptBody = JSON.parse(runtime.apiFetch.mock.calls[2][1].body);

    expect(secondAttemptBody).toEqual(firstAttemptBody);
  });

  it("flushes unsaved changes before switching date, stays on current day if flush fails, and switches when flush succeeds", async () => {
    let shouldFailPut = true;
    runtime.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        if (url.includes("2026-10-28")) {
          return {
            date: "2026-10-28",
            text: "Запись за вчера",
            version: 1,
            updatedAt: "2026-10-28T18:00:00.000Z",
            today: "2026-10-29",
          };
        }
        return {
          date: "2026-10-29",
          text: "Сегодняшний старт",
          version: 1,
          updatedAt: "2026-10-29T08:00:00.000Z",
          today: "2026-10-29",
        };
      }
      if (shouldFailPut) {
        throw new Error("Не удалось сохранить перед переходом");
      }
      const parsed = JSON.parse(String(init.body));
      return {
        date: "2026-10-29",
        text: parsed.text,
        version: 2,
        updatedAt: "2026-10-29T10:00:00.000Z",
        today: "2026-10-29",
      };
    });

    render(<MyDayPage />);
    const editor = await screen.findByLabelText("Что я сделал за день");
    await waitFor(() => expect(editor).not.toBeDisabled());

    fireEvent.change(editor, { target: { value: "Несохранённый итог за 29 октября" } });

    // Click "Предыдущий день" BEFORE 1000ms debounce expires -> triggers immediate flush
    fireEvent.click(screen.getByRole("button", { name: /Предыдущий день/i }));

    expect(await screen.findByText("Не удалось сохранить перед переходом")).toBeInTheDocument();
    // Must remain on 29 October and preserve editor text
    expect(screen.getByRole("heading", { name: /29 октября 2026/i })).toBeInTheDocument();
    expect((editor as HTMLTextAreaElement).value).toBe("Несохранённый итог за 29 октября");
    expect(
      runtime.apiFetch.mock.calls.some(([url]) => String(url).includes("2026-10-28")),
    ).toBe(false);

    // Now allow PUT to succeed and click "Предыдущий день" again
    shouldFailPut = false;
    fireEvent.click(screen.getByRole("button", { name: /Предыдущий день/i }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /28 октября 2026/i })).toBeInTheDocument(),
    );
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("Запись за вчера"));
    expect(runtime.replace).toHaveBeenLastCalledWith("/my-day?date=2026-10-28", {
      scroll: false,
    });
  });

  it("handles 409 conflict by showing both versions and allowing explicit choice without silent overwrite", async () => {
    let putCount = 0;
    runtime.apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return {
          date: "2026-10-29",
          text: "Исходный текст",
          version: 1,
          updatedAt: "2026-10-29T08:00:00.000Z",
          today: "2026-10-29",
        };
      }
      putCount += 1;
      const body = JSON.parse(String(init.body));
      if (putCount === 1) {
        const conflictCurrent: MyDayEntry = {
          date: "2026-10-29",
          text: "Версия из другой вкладки",
          version: 2,
          updatedAt: "2026-10-29T09:30:00.000Z",
          today: "2026-10-29",
        };
        throw Object.assign(new Error("Конфликт версий"), {
          status: 409,
          payload: {
            success: false,
            error: {
              code: "CONFLICT",
              message: "Дневник изменён в другом окне.",
              details: { current: conflictCurrent },
            },
          },
        });
      }
      return {
        date: "2026-10-29",
        text: body.text,
        version: body.expectedVersion + 1,
        updatedAt: "2026-10-29T09:35:00.000Z",
        today: "2026-10-29",
      };
    });

    render(<MyDayPage />);
    const editor = await screen.findByLabelText("Что я сделал за день");
    await waitFor(() => expect(editor).not.toBeDisabled());

    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Мой локальный вариант" } });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    vi.useRealTimers();

    // Both versions must be displayed
    expect(await screen.findByTestId("my-day-conflict-local")).toHaveTextContent(
      "Мой локальный вариант",
    );
    expect(screen.getByTestId("my-day-conflict-server")).toHaveTextContent(
      "Версия из другой вкладки",
    );
    // Editor still holds user's text (no silent overwrite)
    expect((editor as HTMLTextAreaElement).value).toBe("Мой локальный вариант");

    // Choose "Сохранить мой вариант" -> sends PUT with expectedVersion=2
    fireEvent.click(screen.getByRole("button", { name: "Сохранить мой вариант" }));

    await waitFor(() => expect(screen.getByText(/^(Сохранено в \d{2}:\d{2}|Все изменения сохранены)$/)).toBeInTheDocument());
    expect(screen.queryByTestId("my-day-conflict-local")).toBeNull();
    const resolvePutBody = JSON.parse(runtime.apiFetch.mock.calls[2][1].body);
    expect(resolvePutBody.text).toBe("Мой локальный вариант");
    expect(resolvePutBody.expectedVersion).toBe(2);
  });

  it("allows accepting the server version on 409 conflict and clears the local draft", async () => {
    runtime.apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return {
          date: "2026-10-29",
          text: "Старый",
          version: 1,
          updatedAt: "2026-10-29T08:00:00.000Z",
          today: "2026-10-29",
        };
      }
      throw Object.assign(new Error("Конфликт"), {
        status: 409,
        payload: {
          error: {
            code: "CONFLICT",
            details: {
              current: {
                date: "2026-10-29",
                text: "Принятая серверная запись",
                version: 4,
                updatedAt: "2026-10-29T11:00:00.000Z",
                today: "2026-10-29",
              },
            },
          },
        },
      });
    });

    render(<MyDayPage />);
    const editor = await screen.findByLabelText("Что я сделал за день");
    await waitFor(() => expect(editor).not.toBeDisabled());

    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Черновик для отмены" } });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    vi.useRealTimers();

    await screen.findByTestId("my-day-conflict-server");
    fireEvent.click(screen.getByRole("button", { name: "Принять версию с сервера" }));

    expect((editor as HTMLTextAreaElement).value).toBe("Принятая серверная запись");
    expect(window.sessionStorage.getItem(getMyDayDraftKey("actor-1", "2026-10-29"))).toBeNull();
    expect(screen.getByText(/^(Сохранено в \d{2}:\d{2}|Все изменения сохранены)$/)).toBeInTheDocument();
  });

  it("isolates drafts by actorId, ignores stale GET responses across actor switch, and clears drafts on logout", async () => {
    const actor1Get = deferred<MyDayEntry>();
    runtime.apiFetch.mockImplementationOnce(() => actor1Get.promise);

    // Seed a draft for actor-1
    const actor1DraftKey = getMyDayDraftKey("actor-1", "2026-10-29");
    window.sessionStorage.setItem(
      actor1DraftKey,
      JSON.stringify({
        actorId: "actor-1",
        date: "2026-10-29",
        text: "Секретный черновик первого сотрудника",
        baseVersion: 1,
      }),
    );

    const view = render(<MyDayPage />);

    // Switch session to actor-2 before actor-1 GET resolves
    runtime.session = {
      data: { user: { id: "actor-2", name: "Второй Сотрудник", email: "second@example.test" } },
      status: "authenticated",
    };
    runtime.apiFetch.mockImplementationOnce(async () => ({
      date: "2026-10-29",
      text: "Запись второго сотрудника",
      version: 1,
      updatedAt: "2026-10-29T08:30:00.000Z",
      today: "2026-10-29",
    }));

    view.rerender(<MyDayPage />);

    // Resolve stale actor-1 GET late — must NOT leak into actor-2
    await act(async () => {
      actor1Get.resolve({
        date: "2026-10-29",
        text: "Устаревший ответ первого сотрудника",
        version: 1,
        updatedAt: "2026-10-29T08:00:00.000Z",
        today: "2026-10-29",
      });
      await actor1Get.promise;
    });

    const editor = await screen.findByLabelText("Что я сделал за день");
    await waitFor(() => expect(editor).not.toBeDisabled());
    expect((editor as HTMLTextAreaElement).value).toBe("Запись второго сотрудника");
    expect(window.sessionStorage.getItem(actor1DraftKey)).toBeNull();

    // Type a draft as actor-2, then log out
    const actor2DraftKey = getMyDayDraftKey("actor-2", "2026-10-29");
    fireEvent.change(editor, { target: { value: "Черновик второго сотрудника" } });
    expect(window.sessionStorage.getItem(actor2DraftKey)).not.toBeNull();

    runtime.session = { data: null, status: "unauthenticated" };
    view.rerender(<MyDayPage />);

    expect(window.sessionStorage.getItem(actor2DraftKey)).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(/Войдите заново/i);
  });

  it("registers beforeunload when dirty and shows warning if sessionStorage is unavailable while keeping editor functional", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    runtime.apiFetch.mockResolvedValue({
      date: "2026-10-29",
      text: "Начальный текст",
      version: 1,
      updatedAt: "2026-10-29T08:00:00.000Z",
      today: "2026-10-29",
    });

    render(<MyDayPage />);
    const editor = await screen.findByLabelText("Что я сделал за день");
    await waitFor(() => expect(editor).not.toBeDisabled());

    expect(
      screen.getByText(/Локальное хранилище браузера недоступно/i),
    ).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "Изменённый текст без storage" } });

    const unloadEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unloadEvent);
    expect(unloadEvent.defaultPrevented).toBe(true);
  });
});
