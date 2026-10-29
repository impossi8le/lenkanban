import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationRoleUser } from "@/lib/organization-contract";
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: vi.fn(), notFound: vi.fn(), uuid: vi.fn(), session: { status: "authenticated", data: { user: { id: "admin", globalRole: "ADMIN" } } } }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("next-auth/react", () => ({ useSession: () => mocks.session }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: mocks.user, isGlobalAdmin: (user: { globalRole: string }) => user.globalRole === "ADMIN" }));
import RoleManager from "./RoleManager";
import RolesPage, { dynamic } from "./page";
const user: OrganizationRoleUser = { id: "person-one", displayName: "Пользователь", globalRole: "USER" };
const administrator: OrganizationRoleUser = { id: "another-admin", displayName: "Администратор", globalRole: "ADMIN" };
function page(items: OrganizationRoleUser[] = [user, administrator], version = 7, nextCursor: string | null = null) { return { items, version, nextCursor }; }
function error(status: number) { return Object.assign(new Error("PRIVATE_BACKEND_MESSAGE"), { status }); }
function params(url: string) { return new URL(url, "https://synthetic.invalid").searchParams; }
function reads() { return mocks.api.mock.calls.filter(([, options]) => !options?.method); }
function writes() { return mocks.api.mock.calls.filter(([, options]) => options?.method); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const clients: QueryClient[] = [];
function mount(actorId = "admin", initialUserId = "", strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } } }); clients.push(client);
  const tree = (id: string) => { const child = <QueryClientProvider client={client}><RoleManager actorId={id} initialUserId={initialUserId} /></QueryClientProvider>; return strict ? <StrictMode>{child}</StrictMode> : child; };
  const view = render(tree(actorId)); return { client, ...view, rerenderActor: (id: string) => view.rerender(tree(id)) };
}
async function enabled(name: string) { const button = await screen.findByRole("button", { name }); await waitFor(() => expect(button.matches(":disabled")).toBe(false)); return button; }
async function open(id = user.id) { fireEvent.click(await enabled(`Изменить роль ${id}`)); return screen.getByRole("region", { name: "Подтверждение глобальной роли" }); }
async function action(id = user.id) { const panel = await open(id); fireEvent.click(within(panel).getByRole("button", { name: "Подтвердить" })); }
beforeEach(() => {
  mocks.api.mockReset(); mocks.user.mockReset(); mocks.notFound.mockReset(); mocks.uuid.mockReset(); mocks.session.status = "authenticated"; mocks.session.data.user = { id: "admin", globalRole: "ADMIN" };
  let sequence = 0; mocks.uuid.mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`); vi.stubGlobal("crypto", { randomUUID: mocks.uuid });
  mocks.notFound.mockImplementation(() => { throw new Error("NOT_FOUND_SENTINEL"); });
  mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => options?.method ? { result: { id: user.id, globalRole: "ADMIN" }, version: 8, replayed: false } : page());
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });

describe("role directory and server identity", () => {
  it("gates fresh ADMIN before reading optional validated deep link", async () => {
    mocks.user.mockResolvedValue({ id: "server-admin", globalRole: "ADMIN" });
    const result = await RolesPage({ searchParams: Promise.resolve({ userId: "person-one" }) });
    expect(dynamic).toBe("force-dynamic"); expect(result.type).toBe(RoleManager); expect(result.props).toMatchObject({ actorId: "server-admin", initialUserId: "person-one" }); expect(result.key).toBe("server-admin:person-one"); expect(mocks.api).not.toHaveBeenCalled();
  });
  it.each(["bad/path", " ", "x".repeat(129), ["person-one"]])("ignores invalid optional deep link %s", async userId => { mocks.user.mockResolvedValue({ id: "admin", globalRole: "ADMIN" }); expect((await RolesPage({ searchParams: Promise.resolve({ userId }) })).props.initialUserId).toBe(""); });
  it("rejects USER/missing identity before client reads", async () => { mocks.user.mockResolvedValueOnce({ globalRole: "USER" }); await expect(RolesPage({})).rejects.toThrow("NOT_FOUND_SENTINEL"); mocks.user.mockRejectedValueOnce(new Error("Unauthorized")); await expect(RolesPage({})).rejects.toThrow("Unauthorized"); expect(mocks.api).not.toHaveBeenCalled(); });
  it("deep link only searches, bounds reads and survives StrictMode without writes", async () => { mount("admin", "person-one", true); await enabled("Изменить роль person-one"); expect(screen.getByLabelText("Имя или ID пользователя")).toHaveValue("person-one"); expect(reads().every(([url]) => params(url).get("limit") === "50" && params(url).get("q") === "person-one")).toBe(true); expect(writes()).toHaveLength(0); expect(screen.getByText(/ADMIN получает широкий/)).toBeTruthy(); });
  it("normalizes repeated and previously cached searches, restarting at first page", async () => {
    mocks.api.mockResolvedValue(page(undefined, 7, "next")); mount(); fireEvent.click(await enabled("Загрузить ещё"));
    for (const q of [" PERSON ", "", "PERSON", "PERSON"]) { const before = reads().length; fireEvent.change(screen.getByLabelText("Имя или ID пользователя"), { target: { value: q } }); fireEvent.click(screen.getByRole("button", { name: "Найти" })); await waitFor(() => expect(reads().length).toBeGreaterThan(before)); expect(params(reads().at(-1)![0]).get("q")).toBe(q.trim() ? "person" : null); expect(params(reads().at(-1)![0]).has("cursor")).toBe(false); }
  });
  it("distinguishes initial error, empty success and retained page errors; retries exact cursor and restores focus", async () => {
    let attempts = 0; mocks.api.mockImplementation(async (url: string) => { if (!params(url).has("cursor")) return page([user], 7, "opaque/? &"); if (++attempts === 1) throw error(503); return page([administrator]); });
    mount(); fireEvent.click(await enabled("Загрузить ещё")); const retry = await screen.findByRole("button", { name: "Повторить загрузку" }); expect(screen.getByText("Пользователь")).toBeTruthy(); retry.focus(); fireEvent.click(retry); await screen.findByText("Администратор"); await waitFor(() => expect(screen.getByLabelText("Пользователи")).toHaveFocus()); expect(screen.getByRole("button", { name: "Всё загружено" })).toBeDisabled(); expect(reads().filter(([url]) => params(url).get("cursor") === "opaque/? &")).toHaveLength(2); expect(screen.queryByText(/PRIVATE_/)).toBeNull();
  });
  it("initial failure is not a successful empty result", async () => { mocks.api.mockRejectedValueOnce(error(503)).mockResolvedValue(page([])); mount(); await screen.findByRole("alert"); expect(screen.queryByText("Ничего не найдено.")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" })); await screen.findByText("Ничего не найдено."); expect(writes()).toHaveLength(0); });
  it.each(["409", "mixed"])("hides all rows on stale %s paging snapshot", async mode => {
    mocks.api.mockImplementation(async (url: string) => { if (params(url).has("cursor")) { if (mode === "409") throw error(409); return page([administrator], 8); } return page([user], 7, "next"); });
    mount(); fireEvent.click(await enabled("Загрузить ещё")); await screen.findByText(/Версии страниц различаются/); expect(screen.queryByLabelText("Пользователи")).toBeNull(); expect(writes()).toHaveLength(0);
  });
});

describe("audited global role intents", () => {
  it("rereads page one after changing a role on the last page and resets cached user pages", async () => {
    let committed = false;
    mocks.api.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method) {
        committed = true;
        return { result: { id: administrator.id, globalRole: "USER" }, version: 8, replayed: false };
      }
      if (committed) {
        expect(params(url).has("cursor")).toBe(false);
        return page([user], 8);
      }
      return params(url).has("cursor") ? page([administrator]) : page([user], 7, "last-page");
    });
    const view = mount();
    view.client.setQueryData(["adminUsers", ""], {
      pages: [{ items: [{ id: user.id, globalRole: "USER" }], nextCursor: "old" }, { items: [], nextCursor: null }],
      pageParams: [null, "old"],
    });
    fireEvent.click(await enabled("Загрузить ещё"));
    await enabled(`Изменить роль ${administrator.id}`);
    await action(administrator.id);
    await screen.findByText("Изменение подтверждено. Проверьте актуальный список ниже.");
    expect(reads().map(([url]) => params(url).get("cursor"))).toEqual([null, "last-page", null]);
    expect(screen.queryByText("Администратор")).toBeNull();
    expect(screen.getByText("Пользователь")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Всё загружено" })).toBeDisabled();
    const data = view.client.getQueriesData<{ pages: unknown[]; pageParams: unknown[] }>({ queryKey: ["adminRoles", "admin"] })[0][1]!;
    expect(data.pages).toHaveLength(1);
    expect(data.pageParams).toEqual([null]);
    expect(view.client.getQueryData(["adminUsers", ""])).toBeUndefined();
    await waitFor(() => expect(screen.getByLabelText("Пользователи")).toHaveFocus());
    expect(writes()).toHaveLength(1);
  });

  it.each([[user.id, "USER", "ADMIN"], [administrator.id, "ADMIN", "USER"]] as const)("confirms %s current %s to %s with strict metadata and no copied name", async (id, currentRole, globalRole) => {
    mount(); const panel = await open(id); expect(within(panel).getByText(`Текущая роль: ${currentRole}`)).toBeTruthy(); expect(within(panel).getByText(`Новая роль: ${globalRole}`)).toBeTruthy(); await waitFor(() => expect(panel).toHaveFocus()); fireEvent.click(within(panel).getByRole("button", { name: "Подтвердить" }));
    await waitFor(() => expect(writes()).toHaveLength(1)); const [url, options] = writes()[0]; expect(url).toBe(`/api/admin/users/${id}`); expect(options.method).toBe("PATCH"); expect(JSON.parse(options.body)).toEqual({ globalRole, expectedVersion: 7, operationId: "00000000-0000-4000-8000-000000000001" }); expect(options.headers["X-Action-Id"]).toBe("00000000-0000-4000-8000-000000000002");
  });
  it("disables self-demotion without sending a command", async () => { mocks.api.mockResolvedValue(page([{ id: "admin", displayName: "Я", globalRole: "ADMIN" }])); mount(); const button = await screen.findByRole("button", { name: "Изменить роль admin" }); expect(button).toBeDisabled(); fireEvent.click(button); expect(screen.queryByRole("region")).toBeNull(); expect(writes()).toHaveLength(0); });
  it("freezes role and version at OPEN, preventing stale submit even when background refresh completes", async () => {
    let version = 7; mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => options?.method ? { result: {}, version: 9, replayed: false } : page([{ ...user, globalRole: version === 7 ? "USER" : "ADMIN" }], version));
    const view = mount(); await open(); version = 8; await act(async () => { await view.client.refetchQueries({ queryKey: ["adminRoles", "admin"] }); }); await screen.findByText(/Данные изменились после открытия/); expect(screen.getByText("Новая роль: ADMIN")).toBeTruthy(); const confirm = screen.getByRole("button", { name: "Подтвердить" }); expect(confirm).toBeDisabled(); fireEvent.submit(confirm.closest("form")!); expect(writes()).toHaveLength(0); expect(mocks.uuid).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Закрыть" })); await action(); await waitFor(() => expect(writes()).toHaveLength(1)); expect(JSON.parse(writes()[0][1].body)).toMatchObject({ globalRole: "USER", expectedVersion: 8 });
  });
  it.each(["network", "5xx"])("retries immutable unknown %s command/header after newer reads", async mode => {
    let version = 7, attempts = 0; mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => { if (!options?.method) return page(undefined, version); if (++attempts === 1) throw mode === "network" ? new TypeError("private network") : error(503); return { result: { id: "PRIVATE_HISTORY", globalRole: "ADMIN" }, version: 1, replayed: true }; });
    const view = mount(); await action(); await screen.findByText(/Результат неизвестен/); version = 8; await act(async () => { await view.client.refetchQueries({ queryKey: ["adminRoles", "admin"] }); }); fireEvent.click(screen.getByRole("button", { name: "Повторить ту же операцию" })); await waitFor(() => expect(writes()).toHaveLength(2)); expect(writes()[0][1].body).toBe(writes()[1][1].body); expect(writes()[0][1].headers["X-Action-Id"]).toBe(writes()[1][1].headers["X-Action-Id"]); expect(mocks.uuid).toHaveBeenCalledTimes(2); expect(screen.queryByText(/PRIVATE_HISTORY/)).toBeNull();
  });
  it("409 latch survives Close/search/selection and only explicit reload permits a new intent/header", async () => {
    let version = 7, attempts = 0; mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => { if (!options?.method) return page(undefined, version); if (++attempts === 1) { version = 8; throw error(409); } return { result: {}, version: 9, replayed: false }; });
    mount(); await action(); await screen.findByText(/Новые действия заблокированы/); const close = screen.getByRole("button", { name: "Закрыть" }); expect(close).toBeDisabled(); fireEvent.click(close); fireEvent.click(screen.getByRole("button", { name: "Изменить роль another-admin" })); fireEvent.click(screen.getByRole("button", { name: "Сбросить поиск" })); fireEvent.submit(close.closest("form")!); expect(writes()).toHaveLength(1); expect(screen.getByRole("region")).toBeTruthy();
    fireEvent.click(await enabled("Обновить после конфликта")); await action(); await waitFor(() => expect(writes()).toHaveLength(2)); expect(JSON.parse(writes()[1][1].body).expectedVersion).toBe(8); expect(writes()[1][1].headers["X-Action-Id"]).not.toBe(writes()[0][1].headers["X-Action-Id"]);
  });
  it("allows closing a definite rejected request without treating it as unknown", async () => { mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => { if (options?.method) throw error(400); return page(); }); mount(); await action(); await screen.findByText(/Изменение отклонено/); fireEvent.click(await enabled("Закрыть")); expect(screen.queryByRole("region")).toBeNull(); await enabled("Изменить роль person-one"); });
  it("ACK followed by failed refetch retains server-read role, never applies historical DTO or replays mutation", async () => {
    let committed = false; mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => { if (options?.method) { committed = true; return { result: { id: user.id, globalRole: "ADMIN" }, version: 8, replayed: true }; } if (committed) throw error(503); return page(); });
    mount(); await action(); await screen.findByRole("button", { name: "Повторить загрузку" }); expect(screen.queryByText(/Результат неизвестен/)).toBeNull(); expect(screen.getByText("ID: person-one · Текущая роль: USER")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" })); await waitFor(() => expect(reads().length).toBeGreaterThan(2)); expect(writes()).toHaveLength(1);
  });
  it("blocks all pending duplicate submits and search interactions", async () => { const pending = deferred<unknown>(); mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => options?.method ? pending.promise : page()); mount(); await action(); const confirm = screen.getByRole("button", { name: "Сохранение…" }); fireEvent.submit(confirm.closest("form")!); expect(writes()).toHaveLength(1); expect(screen.getByRole("button", { name: "Найти" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Изменить роль another-admin" })).toBeDisabled(); await act(async () => { pending.resolve({ result: {}, version: 8, replayed: false }); }); });
});

describe("role actor boundaries", () => {
  it("does not read for another account", () => { mocks.session.data.user.id = "other"; mount(); expect(screen.getByText(/Данные ролей скрыты/)).toBeTruthy(); expect(reads()).toHaveLength(0); });
  it.each([401, 403])("fresh read %s hides forms and clears the scoped cache, recovery uses a full reload", async code => {
    let revoked = false; mocks.api.mockImplementation(async () => { if (revoked) throw error(code); return page(); }); const view = mount(); await enabled("Изменить роль person-one"); revoked = true; await act(async () => { await view.client.refetchQueries({ queryKey: ["adminRoles", "admin"] }); }); await screen.findByText(/Данные ролей скрыты/);
    // Cache observer cleanup follows the access-loss DOM commit in a passive effect.
    await waitFor(() => expect(view.client.getQueriesData({ queryKey: ["adminRoles", "admin"] })).toHaveLength(0)); expect(screen.queryByLabelText("Выбор роли")).toBeNull();
    const reload = vi.fn(); vi.stubGlobal("window", new Proxy(window, { get(target, key) { return key === "location" ? { reload } : Reflect.get(target, key, target); } })); fireEvent.click(screen.getByRole("button", { name: "Обновить страницу" })); expect(reload).toHaveBeenCalledOnce();
  });
  it("ignores late mutation ACK after an account switch and clears old actor cache", async () => {
    const pending = deferred<unknown>(); mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => options?.method ? pending.promise : page()); const view = mount(); await action(); mocks.session.data.user.id = "other"; view.rerenderActor("admin"); await screen.findByText(/Данные ролей скрыты/); await act(async () => { pending.resolve({ result: { id: "PRIVATE_OLD", globalRole: "ADMIN" }, version: 8, replayed: false }); }); await waitFor(() => expect(view.client.getQueriesData({ queryKey: ["adminRoles", "admin"] })).toHaveLength(0)); expect(screen.queryByRole("region")).toBeNull(); expect(screen.queryByText(/Изменение подтверждено/)).toBeNull(); view.rerenderActor("other"); await enabled("Изменить роль person-one");
  });
  it("fresh mutation403 hides confirmation and does not leave retry controls", async () => { mocks.api.mockImplementation(async (_url: string, options?: RequestInit) => { if (options?.method) throw error(403); return page(); }); const view = mount(); await action(); await screen.findByText(/Данные ролей скрыты/); await waitFor(() => expect(view.client.getQueriesData({ queryKey: ["adminRoles", "admin"] })).toHaveLength(0)); expect(screen.queryByRole("region")).toBeNull(); });
  it("late in-flight page cannot recreate cache or private rows after session role loss", async () => {
    const late = deferred<unknown>(); mocks.api.mockImplementation(async (url: string) => params(url).has("cursor") ? late.promise : page([user], 7, "next"));
    const view = mount(); fireEvent.click(await enabled("Загрузить ещё")); await waitFor(() => expect(reads()).toHaveLength(2));
    mocks.session.data.user.globalRole = "USER"; view.rerenderActor("admin"); await screen.findByText(/Данные ролей скрыты/);
    await waitFor(() => expect(view.client.getQueriesData({ queryKey: ["adminRoles", "admin"] })).toHaveLength(0));
    await act(async () => { late.resolve(page([{ id: "late", displayName: "PRIVATE_LATE", globalRole: "ADMIN" }])); });
    expect(view.client.getQueriesData({ queryKey: ["adminRoles", "admin"] })).toHaveLength(0); expect(screen.queryByText("PRIVATE_LATE")).toBeNull(); expect(screen.queryByLabelText("Выбор роли")).toBeNull();
  });
  it("renders full long names and only minimized DTO fields", async () => { const name = "Д".repeat(120); mocks.api.mockResolvedValue(page([{ ...user, displayName: name, email: "PRIVATE_EMAIL", password: "PRIVATE_HASH" } as OrganizationRoleUser])); mount(); await enabled("Изменить роль person-one"); expect(screen.getByText(name)).toBeTruthy(); expect(screen.queryByText(/PRIVATE_/)).toBeNull(); });
});
