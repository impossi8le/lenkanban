import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationProject, OrganizationDepartment, OrganizationGroup } from "@/lib/organization-contract";
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: vi.fn(), notFound: vi.fn(), uuid: vi.fn(), session: { status: "authenticated", data: { user: { id: "admin", globalRole: "ADMIN" } } } }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("next-auth/react", () => ({ useSession: () => mocks.session }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: mocks.user, isGlobalAdmin: (user: { globalRole: string }) => user.globalRole === "ADMIN" }));
import BindingManager from "./BindingManager";
import BindingsPage, { dynamic } from "./page";
const base = "/api/admin/organization";
const project: OrganizationProject = { id: "project-one", displayName: "Доска", departmentId: "old-department", responsibleGroupId: "old-group" };
const department: OrganizationDepartment = { id: "department-one", name: "Подразделение", parentId: null, leaderId: null, archived: false };
const group: OrganizationGroup = { id: "group-one", name: "Группа", archived: false };
function page<T>(items: T[], version = 7, nextCursor: string | null = null) { return { items, version, nextCursor }; }
function defaults(url: string, version = 7) { return url.includes("/projects?") ? page([project], version) : url.includes("/groups?") ? page([group], version) : { ...page([department], version), parent: null }; }
function params(url: string) { return new URL(url, "https://synthetic.invalid").searchParams; }
function error(status: number) { return Object.assign(new Error("PRIVATE_BACKEND_MESSAGE"), { status }); }
function reads() { return mocks.api.mock.calls.filter(([, options]) => !options?.method); }
function writes() { return mocks.api.mock.calls.filter(([, options]) => options?.method); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const clients: QueryClient[] = [];
function mount(actorId = "admin", strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } } }); clients.push(client);
  const tree = (id: string) => { const child = <QueryClientProvider client={client}><BindingManager actorId={id} /></QueryClientProvider>; return strict ? <StrictMode>{child}</StrictMode> : child; };
  const view = render(tree(actorId)); return { client, ...view, rerenderActor: (id: string) => view.rerender(tree(id)) };
}
async function enabled(name: string) { const button = await screen.findByRole("button", { name }); await waitFor(() => expect(button.matches(":disabled")).toBe(false)); return button; }
async function selectAll() { for (const name of ["Выбрать доску project-one", "Выбрать подразделение department-one", "Выбрать группу group-one"]) fireEvent.click(await enabled(name)); await enabled("Назначить группу"); }
async function action(label: string) { fireEvent.click(await enabled(label)); fireEvent.click(screen.getByRole("button", { name: "Подтвердить" })); }
beforeEach(() => {
  mocks.api.mockReset(); mocks.user.mockReset(); mocks.notFound.mockReset(); mocks.uuid.mockReset(); mocks.session.status = "authenticated"; mocks.session.data.user = { id: "admin", globalRole: "ADMIN" };
  let sequence = 0; mocks.uuid.mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`); vi.stubGlobal("crypto", { randomUUID: mocks.uuid }); mocks.notFound.mockImplementation(() => { throw new Error("NOT_FOUND_SENTINEL"); });
  mocks.api.mockImplementation(async (url: string, options?: RequestInit) => options?.method ? { result: {}, version: 8, replayed: false } : defaults(url));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });

describe("binding page and selectors", () => {
  it("uses fresh dynamic ADMIN gate and actor identity", async () => { mocks.user.mockResolvedValue({ id: "server-admin", globalRole: "ADMIN" }); const result = await BindingsPage(); expect(dynamic).toBe("force-dynamic"); expect(result.type).toBe(BindingManager); expect(result.props.actorId).toBe("server-admin"); expect(result.key).toBe("server-admin"); expect(mocks.api).not.toHaveBeenCalled(); });
  it("denies USER and missing identity before client reads", async () => { mocks.user.mockResolvedValueOnce({ globalRole: "USER" }); await expect(BindingsPage()).rejects.toThrow("NOT_FOUND_SENTINEL"); mocks.user.mockRejectedValueOnce(new Error("Unauthorized")); await expect(BindingsPage()).rejects.toThrow("Unauthorized"); expect(mocks.api).not.toHaveBeenCalled(); });
  it("survives StrictMode, bounds every view and selecting targets does not write", async () => { mount("admin", true); await selectAll(); expect(writes()).toHaveLength(0); expect(reads().every(([url]) => params(url).get("limit") === "50")).toBe(true); expect(screen.getByText(/Названия|Название или существование/)).toBeTruthy(); });
  it("navigates children and roots without reading the whole tree", async () => {
    mocks.api.mockImplementation(async (url: string) => url.includes("/departments?") && params(url).has("parentId") ? { ...page([]), parent: department } : defaults(url)); mount(); fireEvent.click(await enabled("Дочерние подразделения department-one")); fireEvent.click(await enabled("Выбрать текущее подразделение")); expect(reads().some(([url]) => params(url).get("parentId") === department.id)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Корень" })); await enabled("Выбрать подразделение department-one"); expect(params(reads().filter(([url]) => url.includes("/departments?")).at(-1)![0]).has("parentId")).toBe(false);
  });
  it("normalizes repeated/cached project search and resets first-page cursor", async () => {
    mocks.api.mockImplementation(async (url: string) => url.includes("/projects?") ? page([project], 7, "next") : defaults(url)); mount(); fireEvent.click(await enabled("Загрузить ещё: Доски"));
    for (const q of ["  BOARD  ", "", "BOARD", "BOARD"]) { const before = reads().filter(([url]) => url.includes("/projects?")).length; fireEvent.change(screen.getByLabelText("Название или ID доски"), { target: { value: q } }); fireEvent.click(screen.getByRole("button", { name: "Найти" })); await waitFor(() => expect(reads().filter(([url]) => url.includes("/projects?")).length).toBeGreaterThan(before)); const latest = reads().filter(([url]) => url.includes("/projects?")).at(-1)![0]; expect(params(latest).get("q")).toBe(q.trim() ? "board" : null); expect(params(latest).has("cursor")).toBe(false); }
  });
  it.each(["Доски", "Подразделения", "Группы"])("retains %s on page failure and retries the same cursor", async label => {
    let failed = false; const kind = label === "Доски" ? "projects" : label === "Группы" ? "groups" : "departments";
    mocks.api.mockImplementation(async (url: string) => { const data = defaults(url); if (!url.includes(`/${kind}?`)) return data; if (params(url).has("cursor")) { if (!failed) { failed = true; throw error(503); } return data; } return { ...data, nextCursor: "next" }; });
    mount(); fireEvent.click(await enabled(`Загрузить ещё: ${label}`)); await screen.findByRole("button", { name: `Повторить загрузку: ${label}` }); expect(screen.getByLabelText(label)).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: `Повторить загрузку: ${label}` })); await screen.findByRole("button", { name: `Всё загружено: ${label}` }); expect(reads().filter(([url]) => params(url).get("cursor") === "next")).toHaveLength(2); expect(screen.queryByText("PRIVATE_BACKEND_MESSAGE")).toBeNull();
  });
  it("rejects mixed view versions until explicit reload", async () => { let mixed = true; mocks.api.mockImplementation(async (url: string) => defaults(url, mixed && url.includes("/groups?") ? 8 : 7)); mount(); await screen.findByText(/Версии списков различаются/); expect(screen.queryByLabelText("Доски")).toBeNull(); mixed = false; fireEvent.click(await enabled("Загрузить актуальные списки")); await selectAll(); });
  it("handles stale cursor409 by hiding previous pages", async () => { mocks.api.mockImplementation(async (url: string) => { if (!url.includes("/projects?")) return defaults(url); if (params(url).has("cursor")) throw error(409); return page([project], 7, "stale"); }); mount(); fireEvent.click(await enabled("Загрузить ещё: Доски")); await screen.findByText(/Версии списков различаются/); expect(screen.queryByRole("button", { name: "Выбрать доску project-one" })).toBeNull(); });
});

describe("full atomic binding commands", () => {
  it.each([
    ["Назначить подразделение", "department-one", "old-group"], ["Снять подразделение", null, "old-group"], ["Назначить группу", "old-department", "group-one"], ["Снять группу", "old-department", null], ["Снять обе связи", null, null],
  ] as const)("%s shows and sends both resulting IDs", async (label, departmentId, responsibleGroupId) => {
    mount(); if (label === "Снять обе связи") fireEvent.click(await enabled("Выбрать доску project-one")); else await selectAll(); fireEvent.click(await enabled(label));
    const panel = screen.getByRole("region", { name: "Подтверждение привязок" }); expect(within(panel).getByText(`Итоговое подразделение (ID): ${departmentId ?? "нет"}`)).toBeTruthy(); expect(within(panel).getByText(`Итоговая группа (ID): ${responsibleGroupId ?? "нет"}`)).toBeTruthy(); fireEvent.click(within(panel).getByRole("button", { name: "Подтвердить" }));
    await waitFor(() => expect(writes()).toHaveLength(1)); const [url, options] = writes()[0]; expect(url).toBe(`${base}/projects/project-one`); expect(options.method).toBe("PATCH"); expect(JSON.parse(options.body)).toEqual({ departmentId, responsibleGroupId, expectedVersion: 7, operationId: "00000000-0000-4000-8000-000000000001" }); expect(options.headers["X-Action-Id"]).toBe("00000000-0000-4000-8000-000000000002");
  });
  it("blocks archived nonnull targets, while clearBoth needs neither target selector", async () => { mocks.api.mockImplementation(async (url: string) => url.includes("/groups?") ? page([{ ...group, archived: true }]) : url.includes("/departments?") ? { ...page([{ ...department, archived: true }]), parent: null } : defaults(url)); mount(); for (const label of ["Выбрать доску project-one", "Выбрать подразделение department-one", "Выбрать группу group-one"]) fireEvent.click(await enabled(label)); expect(screen.getByRole("button", { name: "Назначить подразделение" }).matches(":disabled")).toBe(true); expect(screen.getByRole("button", { name: "Назначить группу" }).matches(":disabled")).toBe(true); await enabled("Снять обе связи"); });
  it("freezes preserved links/version at open and blocks submit after background advancement", async () => {
    let version = 7; mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (options?.method) return { result: {}, version: 9, replayed: false }; if (url.includes("/projects?")) return page([{ ...project, responsibleGroupId: version === 7 ? "old-group" : "new-other-group" }], version); return defaults(url, version); });
    const view = mount(); await selectAll(); fireEvent.click(await enabled("Назначить подразделение")); version = 8; await act(async () => { await view.client.refetchQueries({ queryKey: ["adminBindings", "admin"] }); }); await screen.findByText(/Данные изменились после открытия/); const confirm = screen.getByRole("button", { name: "Подтвердить" }); expect(confirm.matches(":disabled")).toBe(true); fireEvent.submit(confirm.closest("form")!); expect(writes()).toHaveLength(0); expect(mocks.uuid).not.toHaveBeenCalled(); expect(screen.getByText("Итоговая группа (ID): old-group")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" })); await action("Назначить подразделение"); await waitFor(() => expect(writes()).toHaveLength(1)); expect(JSON.parse(writes()[0][1].body)).toMatchObject({ expectedVersion: 8, responsibleGroupId: "new-other-group" });
  });
  it.each(["network", "5xx"])("exact unknown %s retry preserves original targets/version/header despite newer reads", async mode => {
    let version = 7, attempts = 0; mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (!options?.method) return defaults(url, version); if (++attempts === 1) throw mode === "network" ? new TypeError("private network") : error(503); return { result: { departmentId: "PRIVATE_HISTORY" }, version: 1, replayed: true }; });
    const view = mount(); await selectAll(); await action("Назначить подразделение"); await screen.findByText(/Результат неизвестен/); version = 8; await act(async () => { await view.client.refetchQueries({ queryKey: ["adminBindings", "admin"] }); }); fireEvent.click(screen.getByRole("button", { name: "Повторить ту же операцию" })); await waitFor(() => expect(writes()).toHaveLength(2)); expect(writes()[0][1].body).toBe(writes()[1][1].body); expect(writes()[0][1].headers["X-Action-Id"]).toBe(writes()[1][1].headers["X-Action-Id"]); expect(mocks.uuid).toHaveBeenCalledTimes(2); expect(screen.queryByText(/PRIVATE_HISTORY/)).toBeNull();
  });
  it("409 latch survives attempted Close/selection/search/navigation until explicit reload", async () => {
    let version = 7, attempts = 0; mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (!options?.method) return defaults(url, version); if (++attempts === 1) { version = 8; throw error(409); } return { result: {}, version: 9, replayed: false }; }); mount(); await selectAll(); await action("Назначить группу"); await screen.findByText(/Новые действия заблокированы/);
    const close = screen.getByRole("button", { name: "Закрыть" }); expect(close.matches(":disabled")).toBe(true); fireEvent.click(close); fireEvent.click(screen.getByRole("button", { name: "Корень" })); fireEvent.click(screen.getByRole("button", { name: "Выбрать доску project-one" })); fireEvent.submit(close.closest("form")!); expect(writes()).toHaveLength(1); expect(screen.getByRole("region", { name: "Подтверждение привязок" })).toBeTruthy();
    fireEvent.click(await enabled("Обновить после конфликта")); await action("Назначить группу"); await waitFor(() => expect(writes()).toHaveLength(2)); expect(JSON.parse(writes()[1][1].body).expectedVersion).toBe(8); expect(writes()[1][1].headers["X-Action-Id"]).not.toBe(writes()[0][1].headers["X-Action-Id"]);
  });
  it("does not reapply committed mutation when refetch fails", async () => { let committed = false; mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (options?.method) { committed = true; return { result: {}, version: 8, replayed: false }; } if (committed) throw error(503); return defaults(url); }); mount(); await selectAll(); await action("Снять обе связи"); await screen.findByRole("button", { name: "Повторить загрузку: Доски" }); expect(screen.queryByText(/Результат неизвестен/)).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку: Доски" })); await waitFor(() => expect(reads().length).toBeGreaterThan(6)); expect(writes()).toHaveLength(1); });
  it("gates pending duplicate confirmation and selectors", async () => { const pending = deferred<unknown>(); mocks.api.mockImplementation(async (url: string, options?: RequestInit) => options?.method ? pending.promise : defaults(url)); mount(); await selectAll(); await action("Снять обе связи"); const confirm = screen.getByRole("button", { name: "Сохранение…" }); fireEvent.submit(confirm.closest("form")!); expect(writes()).toHaveLength(1); expect(screen.getByRole("button", { name: "Выбрать доску project-one" }).matches(":disabled")).toBe(true); await act(async () => { pending.resolve({ result: {}, version: 8, replayed: false }); }); });
});

describe("binding actor and privacy boundaries", () => {
  it("does not read for another account", () => { mocks.session.data.user.id = "other"; mount(); expect(screen.getByText(/Данные привязок скрыты/)).toBeTruthy(); expect(reads()).toHaveLength(0); });
  it("clears actor cache on403; late sibling successes cannot recreate rows; recovery is a fullreload", async () => {
    let revoked = false; const late = deferred<unknown>(); mocks.api.mockImplementation(async (url: string) => !revoked ? defaults(url) : url.includes("/projects?") ? Promise.reject(error(403)) : late.promise); const view = mount(); await selectAll(); revoked = true; let refetch!: Promise<void>; await act(async () => { refetch = view.client.refetchQueries({ queryKey: ["adminBindings", "admin"] }); }); await screen.findByText(/Данные привязок скрыты/);
    // Passive observer cleanup may follow the access-loss DOM commit.
    await waitFor(() => expect(view.client.getQueriesData({ queryKey: ["adminBindings", "admin"] })).toHaveLength(0)); await act(async () => { late.resolve(page([{ name: "PRIVATE_LATE" }])); await refetch; }); expect(view.client.getQueriesData({ queryKey: ["adminBindings", "admin"] })).toHaveLength(0); expect(screen.queryByText(/PRIVATE_LATE/)).toBeNull();
    const reload = vi.fn(); vi.stubGlobal("window", new Proxy(window, { get(target, key) { return key === "location" ? { reload } : Reflect.get(target, key, target); } })); try { fireEvent.click(screen.getByRole("button", { name: "Обновить страницу" })); expect(reload).toHaveBeenCalledOnce(); } finally { vi.unstubAllGlobals(); }
  });
  it("does not revive a pending intent/result after account switching", async () => { const pending = deferred<unknown>(); mocks.api.mockImplementation(async (url: string, options?: RequestInit) => options?.method ? pending.promise : defaults(url)); const view = mount(); await selectAll(); await action("Снять обе связи"); mocks.session.data.user.id = "other"; view.rerenderActor("admin"); await screen.findByText(/Данные привязок скрыты/); await act(async () => { pending.resolve({ result: { name: "PRIVATE_OLD" }, version: 8, replayed: false }); }); await waitFor(() => expect(view.client.getQueriesData({ queryKey: ["adminBindings", "admin"] })).toHaveLength(0)); expect(screen.queryByRole("region", { name: "Подтверждение привязок" })).toBeNull(); view.rerenderActor("other"); await enabled("Выбрать доску project-one"); });
  it("renders complete long minimized names without raw content/owner fields", async () => { const name = "Д".repeat(120); mocks.api.mockImplementation(async (url: string) => url.includes("/projects?") ? page([{ ...project, displayName: name, description: "PRIVATE_CONTENT", owner: { email: "PRIVATE_EMAIL" } }]) : defaults(url)); mount(); await enabled("Выбрать доску project-one"); expect(screen.getByText(name)).toBeTruthy(); expect(screen.queryByText(/PRIVATE_/)).toBeNull(); });
});
