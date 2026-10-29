import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import type { OrganizationDepartment, OrganizationDepartmentPage } from "@/lib/organization-contract";

const mocks = vi.hoisted(() => ({ api: vi.fn(), user: vi.fn(), notFound: vi.fn(), uuid: vi.fn(), session: { status: "authenticated", data: { user: { id: "admin", globalRole: "ADMIN" } } } }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("next-auth/react", () => ({ useSession: () => mocks.session }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: mocks.user, isGlobalAdmin: (user: { globalRole: string }) => user.globalRole === "ADMIN" }));
import DepartmentManager from "./DepartmentManager";
import OrganizationPage, { dynamic } from "./page";

const endpoint = "/api/admin/organization/departments";
function department(id = "one", name = "Первое", archived = false): OrganizationDepartment { return { id, name, parentId: null, leaderId: null, archived }; }
function page(items = [department()], version = 3, nextCursor: string | null = null, parent: OrganizationDepartment | null = null): OrganizationDepartmentPage { return { items, version, nextCursor, parent }; }
function httpError(code: number) { return Object.assign(new Error("PRIVATE_SERVER_BODY"), { status: code }); }
function urlParams(url: string) { return new URL(url, "https://synthetic.invalid").searchParams; }
function writes() { return mocks.api.mock.calls.filter(([, options]) => options?.method); }
function reads() { return mocks.api.mock.calls.filter(([, options]) => !options?.method); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const clients: QueryClient[] = [];
function mount(actorId = "admin", strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } } }); clients.push(client);
  const content = (id: string) => <QueryClientProvider client={client}><DepartmentManager actorId={id} /></QueryClientProvider>;
  const tree = (id: string) => strict ? <StrictMode>{content(id)}</StrictMode> : content(id);
  const view = render(tree(actorId));
  return { client, ...view, rerenderActor: (id: string) => view.rerender(tree(id)) };
}
async function createIntent(name = "Новое") {
  const create = await screen.findByRole("button", { name: "Создать подразделение" });
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(create);
  fireEvent.change(screen.getByLabelText("Название"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
}
beforeEach(() => {
  mocks.api.mockReset(); mocks.user.mockReset(); mocks.notFound.mockReset(); mocks.uuid.mockReset();
  mocks.session.status = "authenticated"; mocks.session.data.user = { id: "admin", globalRole: "ADMIN" };
  let sequence = 0; mocks.uuid.mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
  vi.stubGlobal("crypto", { randomUUID: mocks.uuid });
  mocks.notFound.mockImplementation(() => { throw new Error("NOT_FOUND_SENTINEL"); });
  mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => options?.method ? { result: department(), version: 4, replayed: false } : page());
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });

describe("department page server boundary", () => {
  it("is dynamic, uses current ADMIN and scopes the client to the actual actor", async () => {
    mocks.user.mockResolvedValue({ id: "server-admin", globalRole: "ADMIN" });
    const result = await OrganizationPage(); expect(dynamic).toBe("force-dynamic"); expect(result.type).toBe(DepartmentManager); expect(result.key).toBe("server-admin"); expect(result.props.actorId).toBe("server-admin"); expect(mocks.api).not.toHaveBeenCalled();
  });
  it("does not render client data for an ordinary or missing user", async () => {
    mocks.user.mockResolvedValueOnce({ id: "user", globalRole: "USER" }); await expect(OrganizationPage()).rejects.toThrow("NOT_FOUND_SENTINEL");
    mocks.user.mockRejectedValueOnce(new Error("Unauthorized")); await expect(OrganizationPage()).rejects.toThrow("Unauthorized"); expect(mocks.api).not.toHaveBeenCalled();
  });
});

describe("department list and navigation", () => {
  it("loads safely through StrictMode setup/cleanup without removing its active query permanently", async () => {
    mount("admin", true); await screen.findByRole("button", { name: "Первое" });
    expect((screen.getByRole("button", { name: "Создать подразделение" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("loads bounded roots and follows child/root navigation using IDs", async () => {
    mocks.api.mockImplementation(async (url: string) => urlParams(url).get("parentId") ? page([department("child", "Дочернее")], 3, null, department()) : page());
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Первое" }));
    await screen.findByRole("button", { name: "Дочернее" });
    expect(urlParams(reads().at(-1)![0]).get("parentId")).toBe("one"); expect(urlParams(reads()[0][0]).get("limit")).toBe("50");
    fireEvent.click(screen.getByRole("button", { name: "Корневые подразделения" })); await screen.findByRole("button", { name: "Первое" }); expect(urlParams(reads().at(-1)![0]).has("parentId")).toBe(false);
  });
  it("changes archived filter and restarts at the first page", async () => {
    mount(); await screen.findByRole("button", { name: "Первое" }); fireEvent.change(screen.getByLabelText("Архив"), { target: { value: "archived" } });
    await waitFor(() => expect(urlParams(reads().at(-1)![0]).get("archived")).toBe("archived")); expect(urlParams(reads().at(-1)![0]).has("cursor")).toBe(false);
  });
  it("retains rows on next-page failure, retries the exact cursor, and deduplicates rows", async () => {
    let attempts = 0;
    mocks.api.mockImplementation(async (url: string) => { if (urlParams(url).has("cursor")) { if (++attempts === 1) throw httpError(503); return page([department(), department("two", "Второе")], 3); } return page([department()], 3, "cursor-one"); });
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Загрузить ещё" })); await screen.findByRole("alert"); expect(screen.getByRole("button", { name: "Первое" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" })); await screen.findByRole("button", { name: "Второе" }); expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(reads().filter(([url]) => urlParams(url).get("cursor") === "cursor-one")).toHaveLength(2); expect(screen.queryByText("PRIVATE_SERVER_BODY")).toBeNull();
  });
  it("hides previous pages on snapshot409 and requires a fresh first-page read", async () => {
    mocks.api.mockImplementation(async (url: string) => { if (urlParams(url).has("cursor")) throw httpError(409); return page([department()], 3, "old-cursor"); });
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Загрузить ещё" })); await screen.findByText(/Страницы прежнего снимка скрыты/);
    expect(screen.queryByRole("button", { name: "Первое" })).toBeNull(); expect(writes()).toHaveLength(0);
    mocks.api.mockResolvedValue(page([department("fresh", "Актуальное")], 4)); fireEvent.click(screen.getByRole("button", { name: "Загрузить актуальную структуру" })); await screen.findByRole("button", { name: "Актуальное" }); expect(urlParams(reads().at(-1)![0]).has("cursor")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Список подразделений")));
  });
  it("also refuses to merge inconsistent successful page versions", async () => {
    mocks.api.mockImplementation(async (url: string) => urlParams(url).has("cursor") ? page([department("two", "Второе")], 4) : page([department()], 3, "cursor"));
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Загрузить ещё" })); await screen.findByText(/Страницы прежнего снимка скрыты/); expect(screen.queryByRole("table")).toBeNull();
  });
  it("prevents duplicate pending page requests and restores focus after exhaustion", async () => {
    const next = deferred<OrganizationDepartmentPage>(); mocks.api.mockImplementation(async (url: string) => urlParams(url).has("cursor") ? next.promise : page([department()], 3, "next"));
    mount(); const button = await screen.findByRole("button", { name: "Загрузить ещё" }); button.focus(); fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true)); fireEvent.click(button); expect(reads().filter(([url]) => urlParams(url).has("cursor"))).toHaveLength(1);
    await act(async () => { next.resolve(page([], 3)); }); await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Список подразделений")));
  });
});

describe("department commands", () => {
  it("creates a normalized child with the loaded version and a fresh operation UUID", async () => {
    mocks.api.mockImplementation(async (url: string, options?: RequestInit) => options?.method ? { result: department("new", "Новое"), version: 4, replayed: false } : urlParams(url).has("parentId") ? page([], 3, null, department()) : page());
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Первое" })); const create = await screen.findByRole("button", { name: "Создать дочернее" }); await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(create);
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "  Новое  " } }); fireEvent.click(screen.getByRole("button", { name: "Сохранить" })); await screen.findByText(/Изменение сохранено/);
    expect(writes()[0][0]).toBe(endpoint); expect(writes()[0][1].method).toBe("POST"); expect(JSON.parse(writes()[0][1].body)).toEqual({ name: "Новое", parentId: "one", expectedVersion: 3, operationId: "00000000-0000-4000-8000-000000000001" });
  });
  it.each(["rename", "move", "archive", "restore"])("sends closed %s command data", async kind => {
    mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => options?.method ? { result: department(), version: 4, replayed: false } : page([department("one", "Первое", kind === "restore")])); mount(); await screen.findByRole("button", { name: "Первое" });
    const label = kind === "rename" ? "Переименовать" : kind === "move" ? "Переместить" : kind === "archive" ? "Архивировать" : "Восстановить";
    fireEvent.click(screen.getByRole("button", { name: label }));
    if (kind === "rename") fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Новое имя" } });
    if (kind === "move") fireEvent.change(screen.getByLabelText("ID нового родителя (пусто — корень)"), { target: { value: "parent-one" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" })); await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][0]).toBe(`${endpoint}/one`); expect(writes()[0][1].method).toBe("PATCH");
    const body = JSON.parse(writes()[0][1].body); expect(body.expectedVersion).toBe(3); expect(body.operationId).toMatch(/000000000001$/);
    const { operationId: _operationId, expectedVersion: _version, ...command } = body; void _operationId; void _version;
    expect(command).toEqual(kind === "rename" ? { kind: "rename", name: "Новое имя" } : kind === "move" ? { kind: "move", parentId: "parent-one" } : { kind: "archive", archived: kind === "archive" });
  });
  it("validates an explicit parent ID and supports moving to root", async () => {
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Переместить" })); const input = screen.getByLabelText("ID нового родителя (пусто — корень)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bad/parent" } }); expect(input.checkValidity()).toBe(false); fireEvent.submit(input.closest("form")!); expect(writes()).toHaveLength(0);
    fireEvent.change(input, { target: { value: "" } }); fireEvent.click(screen.getByRole("button", { name: "Сохранить" })); await waitFor(() => expect(writes()).toHaveLength(1)); expect(JSON.parse(writes()[0][1].body).parentId).toBeNull();
  });
  it.each(["network", "5xx"])("preserves the exact UUID/version/body for unknown %s retry without applying a snapshot", async failure => {
    let attempts = 0; mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => { if (!options?.method) return page(); if (++attempts === 1) throw failure === "network" ? new TypeError("private network error") : httpError(503); return { result: department("stale", "PRIVATE_REPLAY_SNAPSHOT"), version: 1, replayed: true }; });
    mount(); await createIntent(); await screen.findByText(/Результат неизвестен/);
    expect((screen.getByLabelText("Название") as HTMLInputElement).disabled).toBe(true); expect((screen.getByRole("button", { name: "Создать подразделение" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Повторить ту же операцию" })); await screen.findByText(/Ранее сохранённая операция подтверждена/);
    expect(writes()).toHaveLength(2); expect(writes()[0][1].body).toBe(writes()[1][1].body); expect(mocks.uuid).toHaveBeenCalledOnce(); expect(screen.queryByText("PRIVATE_REPLAY_SNAPSHOT")).toBeNull();
  });
  it("blocks repeat writes on409, reads fresh data and creates a new explicit intent with the new version", async () => {
    let version = 3, attempts = 0; mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => { if (!options?.method) return page([department()], version); if (++attempts === 1) { version = 4; throw httpError(409); } return { result: department(), version: 5, replayed: false }; });
    mount(); await createIntent(); await screen.findByText(/Конфликт версии или ограничений/); expect(writes()).toHaveLength(1); expect(screen.queryByRole("button", { name: "Повторить ту же операцию" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Обновить после конфликта" })); await waitFor(() => expect(screen.queryByRole("region", { name: "Изменение подразделения" })).toBeNull());
    await createIntent("Другое"); await waitFor(() => expect(writes()).toHaveLength(2));
    const original = JSON.parse(writes()[0][1].body), next = JSON.parse(writes()[1][1].body); expect(next.expectedVersion).toBe(4); expect(next.operationId).not.toBe(original.operationId);
  });
  it("cannot dismiss409 or bypass it through navigation/archive filters before explicit reload", async () => {
    mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => { if (options?.method) throw httpError(409); return page(); });
    mount(); await createIntent(); await screen.findByText(/Конфликт версии или ограничений/);
    const beforeReads = reads().length;
    const close = screen.getByRole("button", { name: "Закрыть" }) as HTMLButtonElement;
    expect(close.disabled).toBe(true); fireEvent.click(close);
    expect(screen.getByRole("region", { name: "Изменение подразделения" })).toBeTruthy();
    for (const name of ["Создать подразделение", "Первое", "Корневые подразделения"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true); fireEvent.click(button);
    }
    const filter = screen.getByLabelText("Архив") as HTMLSelectElement;
    expect(filter.disabled).toBe(true); fireEvent.change(filter, { target: { value: "archived" } });
    expect(reads()).toHaveLength(beforeReads); expect(writes()).toHaveLength(1); expect(mocks.uuid).toHaveBeenCalledOnce();
    expect(screen.getByText(/Конфликт версии или ограничений/)).toBeTruthy();
  });
  it("keeps a committed success separate from a failed authoritative refetch", async () => {
    let committed = false; mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => { if (options?.method) { committed = true; return { result: department(), version: 4, replayed: false }; } if (committed) throw httpError(503); return page(); });
    mount(); await createIntent(); await screen.findByText(/Ранее загруженные строки сохранены/); expect(screen.getByText(/Изменение сохранено/)).toBeTruthy(); expect(screen.queryByText(/Результат неизвестен/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" })); await waitFor(() => expect(reads().length).toBeGreaterThan(2)); expect(writes()).toHaveLength(1); expect(screen.getByRole("button", { name: "Первое" })).toBeTruthy();
  });
  it("blocks concurrent command submissions and navigation while a write is pending", async () => {
    const pending = deferred<unknown>(); mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => options?.method ? pending.promise : page());
    mount(); await createIntent(); const region = screen.getByRole("region", { name: "Изменение подразделения" }); fireEvent.submit(within(region).getByRole("button", { name: "Сохранение…" }).closest("form")!); expect(writes()).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Первое" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { pending.resolve({ result: department(), version: 4, replayed: false }); });
  });
});

describe("identity and permission loss", () => {
  it("requests a full reload after losing access, preserving the safe lockout until remount", async () => {
    const view = mount(); await screen.findByRole("button", { name: "Первое" }); mocks.api.mockRejectedValue(httpError(403));
    await act(async () => { await view.client.refetchQueries({ queryKey: ["adminDepartments", "admin"] }); }); await screen.findByText(/Данные подразделений скрыты/);
    mocks.session.data.user.globalRole = "USER"; view.rerenderActor("admin");
    const reload = vi.fn();
    // Only replace the navigation action. No HTTP/browser navigation is executed.
    vi.stubGlobal("window", new Proxy(window, { get(target, key) { return key === "location" ? { reload } : Reflect.get(target, key, target); } }));
    try { fireEvent.click(screen.getByRole("button", { name: "Обновить страницу" })); expect(reload).toHaveBeenCalledOnce(); }
    finally { vi.unstubAllGlobals(); }
    expect(screen.getByText(/Данные подразделений скрыты/)).toBeTruthy(); expect(screen.queryByRole("table")).toBeNull();
    // A real reload remounts both the session provider and the server-gated page.
    view.unmount(); mocks.session.data.user.globalRole = "ADMIN"; mocks.api.mockResolvedValue(page());
    mount(); await screen.findByRole("button", { name: "Первое" });
  });
  it("hides the editor and clears cached rows when a pending mutation reports403", async () => {
    const pending = deferred<unknown>(); mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => options?.method ? pending.promise.then(() => { throw httpError(403); }) : page());
    const view = mount(); await createIntent("REVOKED_DRAFT"); await act(async () => { pending.resolve(null); });
    await screen.findByText(/Данные подразделений скрыты/); expect(screen.queryByRole("region", { name: "Изменение подразделения" })).toBeNull(); expect(screen.queryByRole("table")).toBeNull(); expect(view.client.getQueriesData({ queryKey: ["adminDepartments", "admin"] })).toHaveLength(0);
  });
  it("does not query or show forms for an account mismatch", () => {
    mocks.session.data.user.id = "other-admin"; mount(); expect(screen.getByText(/Данные подразделений скрыты/)).toBeTruthy(); expect(reads()).toHaveLength(0);
  });
  it("hides loaded rows and clears scoped cache when a fresh read reports403", async () => {
    const view = mount(); await screen.findByRole("button", { name: "Первое" }); mocks.api.mockRejectedValue(httpError(403));
    await act(async () => { await view.client.refetchQueries({ queryKey: ["adminDepartments", "admin"] }); }); await screen.findByText(/Данные подразделений скрыты/);
    expect(screen.queryByRole("table")).toBeNull(); expect(view.client.getQueriesData({ queryKey: ["adminDepartments", "admin"] })).toHaveLength(0);
  });
  it("does not revive rows or forms when an old account's pending write resolves after switching", async () => {
    const pending = deferred<unknown>(); mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => options?.method ? pending.promise : page()); const view = mount(); await createIntent("OLD_ACCOUNT_FORM");
    mocks.session.data.user = { id: "other-admin", globalRole: "ADMIN" }; view.rerenderActor("admin"); await screen.findByText(/Данные подразделений скрыты/);
    await act(async () => { pending.resolve({ result: department("secret", "OLD_ACCOUNT_RESULT"), version: 4, replayed: false }); });
    expect(screen.queryByText(/OLD_ACCOUNT/)).toBeNull(); expect(screen.queryByRole("region", { name: "Изменение подразделения" })).toBeNull(); expect(view.client.getQueriesData({ queryKey: ["adminDepartments", "admin"] })).toHaveLength(0);
    view.rerenderActor("other-admin"); await screen.findByRole("button", { name: "Первое" }); expect(screen.queryByDisplayValue("OLD_ACCOUNT_FORM")).toBeNull();
  });
});
