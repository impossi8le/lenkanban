// Highlight marks may split text nodes; assert the exact visible combined text,
// including negative privacy/cache assertions, without depending on markup.
const exactText=(text:string)=>(_:string,node:Element|null)=>Boolean(node&&node.textContent===text&&!Array.from(node.children).some(child=>child.textContent===text));
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), patch: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.fetch, apiPatch: mocks.patch }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
// Keep page/query/mutation behavior real, replacing only Radix interaction.
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, disabled, children }: {
    value: string; onValueChange: (value: string) => void; disabled: boolean; children: React.ReactNode;
  }) => {
    const options: string[] = [];
    function collect(nodes: React.ReactNode) {
      React.Children.forEach(nodes, (node) => {
        if (!React.isValidElement<{ value?: string; children?: React.ReactNode }>(node)) return;
        if (typeof node.props.value === "string") options.push(node.props.value);
        else collect(node.props.children);
      });
    }
    collect(children);
    return <select aria-label="Глобальная роль" value={value} disabled={disabled} onChange={e => onValueChange(e.target.value)}>
      {options.map(option => <option key={option} value={option}>{option}</option>)}
    </select>;
  },
  SelectContent: () => null, SelectItem: () => null,
  SelectTrigger: () => null, SelectValue: () => null,
}));

import AdminUsersPage from "@/app/(dashboard)/admin/users/page";
import AdminProjectsPage from "@/app/(dashboard)/admin/projects/page";

const CURSOR = "opaque/+?= cursor&next";
const clients: QueryClient[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function user(index: number) {
  return {
    id: `user-${index}`, name: `User ${String(index).padStart(3, "0")}`,
    email: `user-${index}@example.invalid`, globalRole: "USER", createdAt: "2026-10-20T10:00:00Z",
    _count: { projects: 1, projectMemberships: 2, apiTokens: 0 },
  };
}
function project(index: number) {
  return {
    id: `project-${index}`, name: `Project ${String(index).padStart(3, "0")}`,
    description: null, createdAt: "2026-10-20T10:00:00Z",
    owner: { id: "owner", name: "Synthetic owner", email: "owner@example.invalid", globalRole: "USER" },
    _count: { tasks: 1, members: 2 },
  };
}
const cases = [
  { kind: "users", Page: AdminUsersPage, rows: Array.from({ length: 51 }, (_, i) => user(i)), first: "User 000", last: "User 050", empty: "Пользователи не найдены." },
  { kind: "projects", Page: AdminProjectsPage, rows: Array.from({ length: 51 }, (_, i) => project(i)), first: "Project 000", last: "Project 050", empty: "Проекты не найдены." },
] as const;
function mount(Page: React.ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  return client;
}
function parsed(url: string) { return new URL(url, "http://localhost"); }

it("focuses the projects region only while it actually overflows, including after resize", async () => {
  let viewportWidth = 375;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => viewportWidth);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(540);
  mocks.fetch.mockResolvedValue({ items: [project(0)], nextCursor: null });
  mount(AdminProjectsPage);
  const list = await screen.findByRole("region", { name: "Список проектов" });
  expect(list).toHaveAttribute("tabindex", "0");
  list.focus();
  expect(list).toHaveFocus();
  viewportWidth = 900;
  fireEvent(window, new Event("resize"));
  expect(list).not.toHaveAttribute("tabindex");
  viewportWidth = 400;
  fireEvent(window, new Event("resize"));
  expect(list).toHaveAttribute("tabindex", "0");
});

beforeEach(() => {
  vi.resetAllMocks();
  // jsdom has no layout; model the overflowing projects table explicitly.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("aria-label") === "Список проектов" ? 320 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("aria-label") === "Список проектов" ? 540 : 0;
  });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

describe.each(cases)("admin $kind pagination with real QueryClient", ({ kind, Page, rows, first, last, empty }) => {
  it("keeps pagination outside the scrollable table with wrapping controls at 320px", async () => {
    if (kind === "projects") {
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(540);
    }
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    try {
      mocks.fetch.mockImplementation(async (url: string) => parsed(url).searchParams.has("cursor")
        ? { items: [rows[50]], nextCursor: null }
        : { items: rows.slice(0, 50), nextCursor: CURSOR });
      mount(Page);
      await screen.findByText(exactText(first));
      const list = screen.getByLabelText(kind === "users" ? "Список пользователей" : "Список проектов");
      expect(list).toHaveClass("max-w-full", "overflow-x-auto");
      if (kind === "projects") {
        expect(screen.getByRole("region", { name: "Список проектов" })).toBe(list);
        expect(list).toHaveAttribute("tabindex", "0");
        list.focus();
        expect(list).toHaveFocus();
        expect(list).toHaveClass("focus-visible:ring-2", "focus-visible:ring-inset");
      } else {
        for (const link of screen.getAllByRole("link", { name: "Изменить роль" })) {
          expect(link).toHaveClass("inline-flex", "min-h-11", "focus-visible:ring-2");
        }
      }
      const more = screen.getByRole("button", { name: "Загрузить ещё" });
      expect(list).not.toContainElement(more);
      expect(more).toHaveClass("max-w-full", "whitespace-normal", "h-auto", "min-h-11");
      expect(more.parentElement).toHaveClass("min-w-0", "max-w-full", "flex-col");
      more.focus();
      expect(more).toHaveFocus();
      fireEvent.click(more);
      await screen.findByText(exactText(last));
      await waitFor(() => expect(screen.getByText(exactText(last)).closest("tr")).toHaveFocus());
      expect(screen.getByRole("button", { name: "Всё загружено" })).toBeDisabled();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    }
  });

  it("loads 51 distinct rows using an opaque cursor, suppresses pending double clicks and disables the end", async () => {
    const second = deferred<{ items: typeof rows[number][]; nextCursor: null }>();
    mocks.fetch.mockImplementation(async (url: string) => {
      const request = parsed(url);
      expect(request.pathname).toBe(`/api/admin/${kind}`);
      expect(request.searchParams.get("take")).toBe("50");
      if (!request.searchParams.has("cursor")) return { items: rows.slice(0, 50), nextCursor: CURSOR };
      expect(request.searchParams.get("cursor")).toBe(CURSOR);
      return second.promise;
    });
    mount(Page);
    await screen.findByText(exactText(first));
    const more = screen.getByRole("button", { name: "Загрузить ещё" });
    fireEvent.click(more);
    fireEvent.click(more);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    const pending = screen.getByRole("button", { name: "Загрузка..." });
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending).not.toBeDisabled();
    await act(async () => second.resolve({ items: [rows[49], rows[50]], nextCursor: null }));
    await screen.findByText(exactText(last));
    expect(screen.getAllByRole("row")).toHaveLength(52);
    expect(screen.getAllByText(rows[49].name!)).toHaveLength(1);
    const end = screen.getByRole("button", { name: "Всё загружено" });
    expect(end).toBeDisabled();
    fireEvent.click(end);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps focus on the load-more control, announces loading and returns focus after a successful page", async () => {
    const second = deferred<{ items: typeof rows[number][]; nextCursor: string }>();
    mocks.fetch.mockImplementation(async (url: string) => {
      if (!parsed(url).searchParams.has("cursor")) return { items: rows.slice(0, 50), nextCursor: CURSOR };
      return second.promise;
    });
    mount(Page);
    await screen.findByText(exactText(first));
    const more = screen.getByRole("button", { name: "Загрузить ещё" });
    more.focus();
    expect(more).toHaveFocus();
    fireEvent.click(more);
    await waitFor(() => expect(screen.getByRole("button", { name: "Загрузка..." })).toHaveAttribute("aria-busy", "true"));
    const pending = screen.getByRole("button", { name: "Загрузка..." });
    expect(document.activeElement).not.toBe(document.body);
    expect(pending).toHaveFocus();
    expect(screen.getByText(exactText("Загрузка дополнительных данных..."))).toBeInTheDocument();
    expect(screen.getByLabelText(kind === "users" ? "Список пользователей" : "Список проектов")).toHaveAttribute("aria-busy", "true");
    await act(async () => second.resolve({ items: [rows[50]], nextCursor: "another-page" }));
    await screen.findByText(exactText(last));
    await waitFor(() => expect(screen.getByRole("button", { name: "Загрузить ещё" })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByLabelText(kind === "users" ? "Список пользователей" : "Список проектов")).toHaveAttribute("aria-busy", "false");
  });

  it("moves focus to the first new row when a successful load exhausts the list", async () => {
    const second = deferred<{ items: typeof rows[number][]; nextCursor: null }>();
    mocks.fetch.mockImplementation(async (url: string) => {
      if (!parsed(url).searchParams.has("cursor")) return { items: rows.slice(0, 50), nextCursor: CURSOR };
      return second.promise;
    });
    mount(Page);
    await screen.findByText(exactText(first));
    const more = screen.getByRole("button", { name: "Загрузить ещё" });
    more.focus();
    fireEvent.click(more);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve({ items: [rows[49], rows[50]], nextCursor: null }));
    await screen.findByText(exactText(last));
    const end = screen.getByRole("button", { name: "Всё загружено" });
    expect(end).toBeDisabled();
    const newRow = screen.getByText(exactText(last)).closest("tr")!;
    await waitFor(() => expect(newRow).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBe(end);
    expect(screen.getAllByRole("row")).toHaveLength(52);
  });

  it("retains the loaded 50 rows on a later-page error and retries the same cursor", async () => {
    let secondAttempts = 0;
    mocks.fetch.mockImplementation(async (url: string) => {
      const cursor = parsed(url).searchParams.get("cursor");
      if (!cursor) return { items: rows.slice(0, 50), nextCursor: CURSOR };
      expect(cursor).toBe(CURSOR);
      if (++secondAttempts === 1) throw new Error("Synthetic later-page failure");
      return { items: [rows[50]], nextCursor: null };
    });
    mount(Page);
    await screen.findByText(exactText(first));
    fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё" }));
    await screen.findByRole("alert");
    expect(screen.getByText(exactText(first))).toBeInTheDocument();
    expect(screen.queryByText(exactText(empty))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByText(exactText(last));
    expect(screen.getAllByRole("row")).toHaveLength(52);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it("shows an initial error with retry instead of a successful empty state", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("Synthetic initial failure"))
      .mockResolvedValueOnce({ items: [rows[0]], nextCursor: null });
    mount(Page);
    await screen.findByRole("alert");
    expect(screen.queryByText(exactText(empty))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByText(exactText(first));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a successful empty first page without a pagination request", async () => {
    mocks.fetch.mockResolvedValue({ items: [], nextCursor: null });
    mount(Page);
    await screen.findByText(exactText(empty));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Загрузить ещё" })).not.toBeInTheDocument();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("moves focus from a successful retry to the list when the final page is exhausted", async () => {
    let attempts = 0;
    const retryPage = deferred<{ items: typeof rows[number][]; nextCursor: null }>();
    mocks.fetch.mockImplementation(async (url: string) => {
      if (!parsed(url).searchParams.has("cursor")) return { items: rows.slice(0, 50), nextCursor: CURSOR };
      if (++attempts === 1) throw new Error("Synthetic page failure");
      return retryPage.promise;
    });
    mount(Page);
    await screen.findByText(exactText(first));
    fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё" }));
    const retry = await screen.findByRole("button", { name: "Повторить" });
    retry.focus();
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    await act(async () => retryPage.resolve({ items: [rows[50]], nextCursor: null }));
    await screen.findByText(exactText(last));
    await waitFor(() => expect(screen.getByLabelText(kind === "users" ? "Список пользователей" : "Список проектов")).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Повторить" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Всё загружено" })).toBeDisabled();
  });
});

it("resets users cursor for trimmed search and ignores an old in-flight page response", async () => {
  const oldPage = deferred<{ items: ReturnType<typeof user>[]; nextCursor: null }>();
  mocks.fetch.mockImplementation(async (url: string) => {
    const params = parsed(url).searchParams;
    if (params.get("q") === "needle") {
      expect(params.has("cursor")).toBe(false);
      return { items: [{ ...user(99), name: "Needle result" }], nextCursor: null };
    }
    if (params.has("cursor")) return oldPage.promise;
    return { items: Array.from({ length: 50 }, (_, i) => user(i)), nextCursor: CURSOR };
  });
  mount(AdminUsersPage);
  await screen.findByText(exactText("User 000"));
  fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё" }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  fireEvent.change(screen.getByRole("textbox", { name: "Поиск пользователей" }), { target: { value: "  needle  " } });
  await screen.findByText(exactText("Needle result"));
  expect(screen.queryByText(exactText("User 000"))).not.toBeInTheDocument();
  await act(async () => oldPage.resolve({ items: [user(50)], nextCursor: null }));
  expect(screen.queryByText(exactText("User 050"))).not.toBeInTheDocument();
  expect(screen.getByText(exactText("Needle result"))).toBeInTheDocument();
  const beforeWhitespace = mocks.fetch.mock.calls.length;
  fireEvent.change(screen.getByRole("textbox", { name: "Поиск пользователей" }), { target: { value: "needle" } });
  await act(async () => { await Promise.resolve(); });
  expect(mocks.fetch).toHaveBeenCalledTimes(beforeWhitespace);
});

it("keeps roles read-only and links the paged user to explicit role management without writing", async () => {
  const rows = Array.from({ length: 51 }, (_, i) => user(i));
  mocks.fetch.mockImplementation(async (url: string) => parsed(url).searchParams.has("cursor")
    ? { items: [rows[50]], nextCursor: null } : { items: rows.slice(0, 50), nextCursor: CURSOR });
  mount(AdminUsersPage);
  await screen.findByText(exactText("User 000"));
  fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё" }));
  const row = (await screen.findByText(exactText("User 050"))).closest("tr")!;
  expect(within(row).getByText(exactText("USER"))).toBeInTheDocument();
  expect(within(row).getByRole("link", { name: "Изменить роль" })).toHaveAttribute("href", "/admin/organization/roles?userId=user-50");
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getAllByRole("row")).toHaveLength(52);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(mocks.patch).not.toHaveBeenCalled();
});

it("returning to a previous users search starts from page one instead of reusing its two-page cache", async () => {
  const alpha = Array.from({ length: 51 }, (_, i) => ({ ...user(i), name: `Alpha ${String(i).padStart(3, "0")}` }));
  mocks.fetch.mockImplementation(async (url: string) => {
    const params = parsed(url).searchParams;
    if (params.get("q") === "alpha") return params.has("cursor")
      ? { items: [alpha[50]], nextCursor: null }
      : { items: alpha.slice(0, 50), nextCursor: CURSOR };
    return { items: [{ ...user(100), name: params.get("q") === "beta" ? "Beta result" : "Initial result" }], nextCursor: null };
  });
  mount(AdminUsersPage);
  await screen.findByText(exactText("Initial result"));
  const search = screen.getByRole("textbox", { name: "Поиск пользователей" });
  fireEvent.change(search, { target: { value: "alpha" } });
  await screen.findByText(exactText("Alpha 000"));
  fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё" }));
  await screen.findByText(exactText("Alpha 050"));
  fireEvent.change(search, { target: { value: "beta" } });
  await screen.findByText(exactText("Beta result"));
  fireEvent.change(search, { target: { value: " alpha " } });
  await screen.findByText(exactText("Alpha 000"));
  expect(screen.queryByText(exactText("Alpha 050"))).not.toBeInTheDocument();
  expect(screen.getAllByRole("row")).toHaveLength(51);
  const alphaRequests = mocks.fetch.mock.calls.map(([url]) => parsed(url)).filter(url => url.searchParams.get("q") === "alpha");
  expect(alphaRequests.map(url => url.searchParams.get("cursor"))).toEqual([null, CURSOR, null]);
});

it("retains read-only roles, counts and all loaded users when a directory refetch fails", async () => {
  const rows = Array.from({ length: 51 }, (_, i) => user(i)); let failed = false;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (failed) throw new Error("Synthetic directory refetch failure");
    return parsed(url).searchParams.has("cursor") ? { items: [rows[50]], nextCursor: null } : { items: rows.slice(0, 50), nextCursor: CURSOR };
  });
  const client = mount(AdminUsersPage);
  await screen.findByText(exactText("User 000"));
  fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё" }));
  await screen.findByText(exactText("User 050")); failed = true;
  await act(async () => { await client.refetchQueries({ queryKey: ["adminUsers"] }); });
  await screen.findByRole("alert");
  const row = screen.getByText(exactText("User 050")).closest("tr")!;
  expect(within(row).getByText(exactText("USER"))).toBeInTheDocument();
  expect(within(row).getByText(exactText("владелец: 1"))).toBeInTheDocument();
  expect(within(row).getByText(exactText("участник: 2"))).toBeInTheDocument();
  expect(within(row).getByRole("link", { name: "Изменить роль" })).toHaveAttribute("href", "/admin/organization/roles?userId=user-50");
  expect(screen.getAllByRole("row")).toHaveLength(52);
  expect(screen.getByText(exactText("User 000"))).toBeInTheDocument();
  expect(mocks.patch).not.toHaveBeenCalled();
});
