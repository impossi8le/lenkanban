import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationDepartment, OrganizationPerson } from "@/lib/organization-contract";

const mocks = vi.hoisted(() => ({ api: vi.fn(), user: vi.fn(), notFound: vi.fn(), uuid: vi.fn(), session: { status: "authenticated", data: { user: { id: "admin", globalRole: "ADMIN" } } } }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("next-auth/react", () => ({ useSession: () => mocks.session }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: mocks.user, isGlobalAdmin: (user: { globalRole: string }) => user.globalRole === "ADMIN" }));
import AssignmentManager from "./AssignmentManager";
import AssignmentsPage, { dynamic } from "./page";

const base = "/api/admin/organization";
const department: OrganizationDepartment = { id: "department-one", name: "Подразделение", parentId: null, leaderId: "old-leader", archived: false };
const person: OrganizationPerson = { id: "person-one", displayName: "Сотрудник", primaryDepartmentId: "other-department" };
function page<T>(items: T[], version = 4, nextCursor: string | null = null) { return { items, version, nextCursor }; }
function params(url: string) { return new URL(url, "https://synthetic.invalid").searchParams; }
function failure(status: number) { return Object.assign(new Error("PRIVATE_BACKEND_MESSAGE"), { status }); }
function defaults(url: string) { return url.includes("/people?") ? page([person]) : { ...page([department]), parent: null }; }
function writes() { return mocks.api.mock.calls.filter(([, options]) => options?.method); }
function reads() { return mocks.api.mock.calls.filter(([, options]) => !options?.method); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const clients: QueryClient[] = [];
function mount(actorId = "admin", strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } } }); clients.push(client);
  const tree = (id: string) => { const content = <QueryClientProvider client={client}><AssignmentManager actorId={id} /></QueryClientProvider>; return strict ? <StrictMode>{content}</StrictMode> : content; };
  const view = render(tree(actorId)); return { client, ...view, rerenderActor: (id: string) => view.rerender(tree(id)) };
}
async function enabled(name: string) { const button = await screen.findByRole("button", { name }); await waitFor(() => expect(button.matches(":disabled")).toBe(false)); return button; }
async function selectBoth() { fireEvent.click(await enabled("Выбрать подразделение department-one")); fireEvent.click(await enabled("Выбрать сотрудника person-one")); await enabled("Снять основное подразделение"); }
async function confirmAction(label: string) { fireEvent.click(await enabled(label)); fireEvent.click(screen.getByRole("button", { name: "Подтвердить" })); }
beforeEach(() => {
  mocks.api.mockReset(); mocks.user.mockReset(); mocks.notFound.mockReset(); mocks.uuid.mockReset(); mocks.session.status = "authenticated"; mocks.session.data.user = { id: "admin", globalRole: "ADMIN" };
  let sequence = 0; mocks.uuid.mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`); vi.stubGlobal("crypto", { randomUUID: mocks.uuid });
  mocks.notFound.mockImplementation(() => { throw new Error("NOT_FOUND_SENTINEL"); });
  mocks.api.mockImplementation(async (url: string, options?: RequestInit) => options?.method ? { result: {}, version: 5, replayed: false } : defaults(url));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });

describe("assignment server gate and read selection", () => {
  it("requires current ADMIN and returns a dynamic actor-scoped client", async () => {
    mocks.user.mockResolvedValue({ id: "server-admin", globalRole: "ADMIN" }); const result = await AssignmentsPage(); expect(dynamic).toBe("force-dynamic"); expect(result.type).toBe(AssignmentManager); expect(result.key).toBe("server-admin"); expect(result.props.actorId).toBe("server-admin"); expect(mocks.api).not.toHaveBeenCalled();
  });
  it("hides the page from USER and propagates missing identity without client reads", async () => {
    mocks.user.mockResolvedValueOnce({ id: "user", globalRole: "USER" }); await expect(AssignmentsPage()).rejects.toThrow("NOT_FOUND_SENTINEL"); mocks.user.mockRejectedValueOnce(new Error("Unauthorized")); await expect(AssignmentsPage()).rejects.toThrow("Unauthorized"); expect(mocks.api).not.toHaveBeenCalled();
  });
  it("survives StrictMode and selection never writes or auto-matches a department", async () => {
    mount("admin", true); await selectBoth(); expect(writes()).toHaveLength(0); expect(screen.getByText("Текущий руководитель (ID): old-leader")).toBeTruthy(); expect(screen.getAllByText(/other-department/).length).toBeGreaterThan(0);
    expect(reads().every(([url]) => params(url).get("limit") === "50")).toBe(true); expect(screen.getByText(/не переводится в подразделение автоматически/)).toBeTruthy();
  });
  it("navigates bounded children and roots while resetting department selection", async () => {
    mocks.api.mockImplementation(async (url: string) => url.includes("/people?") ? page([person]) : params(url).has("parentId") ? { ...page([{ ...department, id: "child", parentId: department.id, name: "Дочернее" }]), parent: department } : defaults(url));
    mount(); fireEvent.click(await enabled("Выбрать подразделение department-one")); fireEvent.click(await enabled("Дочерние подразделения department-one")); await screen.findByText("Дочернее"); expect(screen.getByText("Подразделение не выбрано в текущем списке.")).toBeTruthy();
    fireEvent.click(await enabled("Выбрать текущее подразделение")); await enabled("Снять руководителя"); expect(reads().some(([url]) => params(url).get("parentId") === department.id)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Корень" })); await screen.findByRole("button", { name: "Выбрать подразделение department-one" }); expect(params(reads().filter(([url]) => url.includes("/departments?")).at(-1)![0]).has("parentId")).toBe(false);
  });
  it("filters archived departments without silently retaining an invisible selection", async () => {
    mount(); await selectBoth(); fireEvent.change(screen.getByLabelText("Архив подразделений"), { target: { value: "archived" } }); await enabled("Выбрать подразделение department-one");
    expect(params(reads().filter(([url]) => url.includes("/departments?")).at(-1)![0]).get("archived")).toBe("archived"); expect(screen.getByText("Подразделение не выбрано в текущем списке.")).toBeTruthy();
  });
  it.each(["Подразделения", "Сотрудники"])("retains %s on next-page failure and retries the same cursor", async label => {
    let failed = false; mocks.api.mockImplementation(async (url: string) => {
      const target = label === "Подразделения" ? url.includes("/departments?") : url.includes("/people?"); if (!target) return defaults(url);
      if (params(url).has("cursor")) { if (!failed) { failed = true; throw failure(503); } return label === "Подразделения" ? { ...page([department]), parent: null } : page([person]); }
      return label === "Подразделения" ? { ...page([department], 4, "next"), parent: null } : page([person], 4, "next");
    }); mount(); fireEvent.click(await enabled(`Загрузить ещё: ${label}`)); await screen.findByRole("button", { name: `Повторить загрузку: ${label}` }); expect(screen.getByLabelText(label)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Повторить загрузку: ${label}` })); await waitFor(() => expect(screen.getByRole("button", { name: `Всё загружено: ${label}` }).matches(":disabled")).toBe(true)); expect(reads().filter(([url]) => params(url).get("cursor") === "next")).toHaveLength(2); expect(screen.queryByText("PRIVATE_BACKEND_MESSAGE")).toBeNull();
  });
  it("normalizes repeated/cached people searches and resets selection plus cursor pages", async () => {
    mocks.api.mockImplementation(async (url: string) => url.includes("/people?") ? page([person], 4, "next") : defaults(url)); mount(); fireEvent.click(await enabled("Выбрать сотрудника person-one")); fireEvent.click(await enabled("Загрузить ещё: Сотрудники"));
    for (const q of ["  ALICE  ", "", "ALICE", "ALICE"]) {
      const before = reads().filter(([url]) => url.includes("/people?")).length; fireEvent.change(screen.getByLabelText("Имя или ID"), { target: { value: q } }); fireEvent.click(screen.getByRole("button", { name: "Найти" }));
      await waitFor(() => expect(reads().filter(([url]) => url.includes("/people?")).length).toBeGreaterThan(before)); const latest = reads().filter(([url]) => url.includes("/people?")).at(-1)![0]; expect(params(latest).get("q")).toBe(q.trim() ? "alice" : null); expect(params(latest).has("cursor")).toBe(false); expect(screen.getByText("Сотрудник не выбран в текущем списке.")).toBeTruthy();
    }
  });
  it.each(["mismatch", "cursor409"])("hides all stale views and blocks writes for %s until explicit refresh", async mode => {
    let stale = true; mocks.api.mockImplementation(async (url: string) => {
      if (!stale) return defaults(url);
      if (mode === "mismatch") return url.includes("/people?") ? page([person], 5) : defaults(url);
      if (url.includes("/people?")) { if (params(url).has("cursor")) throw failure(409); return page([person], 4, "stale"); }
      return defaults(url);
    }); mount(); if (mode === "cursor409") fireEvent.click(await enabled("Загрузить ещё: Сотрудники")); await screen.findByText(/Версии списков различаются/); expect(screen.queryByLabelText("Подразделения")).toBeNull(); expect(writes()).toHaveLength(0);
    stale = false; fireEvent.click(await enabled("Загрузить актуальные списки")); await selectBoth();
  });
});

describe("leader and primary department command contracts", () => {
  it.each(["leader-set", "leader-clear", "primary-set", "primary-clear"])("confirms a narrow %s command with a fresh UUID and loaded version", async action => {
    mount(); if (action !== "primary-clear") fireEvent.click(await enabled("Выбрать подразделение department-one")); if (action !== "leader-clear") fireEvent.click(await enabled("Выбрать сотрудника person-one"));
    const label = action === "leader-set" ? "Назначить руководителя" : action === "leader-clear" ? "Снять руководителя" : action === "primary-set" ? "Назначить основное подразделение" : "Снять основное подразделение";
    await confirmAction(label); await waitFor(() => expect(writes()).toHaveLength(1)); const [url, options] = writes()[0]; expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body)).toEqual({ ...(action.startsWith("leader") ? { kind: "leader", leaderId: action === "leader-set" ? person.id : null } : { departmentId: action === "primary-set" ? department.id : null }), operationId: "00000000-0000-4000-8000-000000000001", expectedVersion: 4 });
    expect(url).toBe(`${base}/${action.startsWith("leader") ? "departments/department-one" : "people/person-one"}`);
    expect(options.headers["X-Action-Id"]).toBe("00000000-0000-4000-8000-000000000002");
  });
  it("permits clearing an archived leader but blocks new leader and primary assignments", async () => {
    mocks.api.mockImplementation(async (url: string, options?: RequestInit) => options?.method ? { result: {}, version: 5, replayed: false } : url.includes("/departments?") ? { ...page([{ ...department, archived: true }]), parent: null } : defaults(url)); mount(); await selectBoth();
    expect(screen.getByRole("button", { name: "Назначить руководителя" }).matches(":disabled")).toBe(true); expect(screen.getByRole("button", { name: "Назначить основное подразделение" }).matches(":disabled")).toBe(true);
    await confirmAction("Снять руководителя"); await waitFor(() => expect(writes()).toHaveLength(1)); expect(JSON.parse(writes()[0][1].body).leaderId).toBeNull();
  });
  it.each(["network", "5xx"])("retries unknown %s with the identical body even after read versions advance", async mode => {
    let attempts = 0, version = 4; mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (!options?.method) return { ...defaults(url), version }; if (++attempts === 1) throw mode === "network" ? new TypeError("private network") : failure(503); return { result: { leaderId: "PRIVATE_HISTORICAL_SNAPSHOT" }, version: 1, replayed: true }; });
    const view = mount(); await selectBoth(); await confirmAction("Назначить руководителя"); await screen.findByText(/Результат неизвестен/); expect(screen.getByRole("button", { name: "Закрыть" }).matches(":disabled")).toBe(true); version = 5; await act(async () => { await view.client.refetchQueries({ queryKey: ["adminAssignments", "admin"] }); });
    fireEvent.click(screen.getByRole("button", { name: "Повторить ту же операцию" })); await screen.findByText(/Ранее сохранённая операция подтверждена/); expect(writes()).toHaveLength(2); expect(writes()[0][1].body).toBe(writes()[1][1].body); expect(writes()[0][1].headers["X-Action-Id"]).toBe(writes()[1][1].headers["X-Action-Id"]); expect(mocks.uuid).toHaveBeenCalledTimes(2); expect(screen.queryByText(/PRIVATE_HISTORICAL/)).toBeNull();
  });
  it("blocks selection tricks after409 and requires a fresh read plus a new intent", async () => {
    let version = 4, attempts = 0; mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (!options?.method) return { ...defaults(url), version }; if (++attempts === 1) { version = 5; throw failure(409); } return { result: {}, version: 6, replayed: false }; });
    mount(); await selectBoth(); await confirmAction("Назначить руководителя"); await screen.findByText(/Конфликт версии или ограничений/); fireEvent.click(screen.getByRole("button", { name: "Выбрать сотрудника person-one" })); expect(screen.getByText(/Конфликт версии или ограничений/)).toBeTruthy(); expect(writes()).toHaveLength(1);
    fireEvent.click(await enabled("Обновить после конфликта")); await confirmAction("Назначить руководителя"); await waitFor(() => expect(writes()).toHaveLength(2)); const first = JSON.parse(writes()[0][1].body), next = JSON.parse(writes()[1][1].body); expect(next.expectedVersion).toBe(5); expect(next.operationId).not.toBe(first.operationId); expect(writes()[1][1].headers["X-Action-Id"]).not.toBe(writes()[0][1].headers["X-Action-Id"]);
  });
  it("does not reapply a committed mutation when authoritative refetch fails", async () => {
    let committed = false; mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (options?.method) { committed = true; return { result: {}, version: 5, replayed: false }; } if (committed) throw failure(503); return defaults(url); });
    mount(); await selectBoth(); await confirmAction("Назначить основное подразделение"); await screen.findByText(/Изменение сохранено/); await screen.findByRole("button", { name: "Повторить загрузку: Сотрудники" }); expect(screen.queryByText(/Результат неизвестен/)).toBeNull(); expect(screen.getByText("Текущий руководитель (ID): old-leader")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку: Сотрудники" })); await waitFor(() => expect(reads().length).toBeGreaterThan(4)); expect(writes()).toHaveLength(1);
  });
  it("cannot dismiss409 and submit another intent before an explicit reload", async () => {
    let version = 4, attempts = 0;
    mocks.api.mockImplementation(async (url: string, options?: RequestInit) => {
      if (!options?.method) return { ...defaults(url), version };
      if (++attempts === 1) { version = 5; throw failure(409); }
      return { result: {}, version: 6, replayed: false };
    });
    mount(); await selectBoth(); await confirmAction("Назначить руководителя"); await screen.findByText(/Конфликт версии или ограничений/);
    const close = screen.getByRole("button", { name: "Закрыть" }); expect(close.matches(":disabled")).toBe(true); fireEvent.click(close);
    expect(screen.getByRole("region", { name: "Подтверждение назначения" })).toBeTruthy();
    const nextAction = screen.getByRole("button", { name: "Назначить основное подразделение" }); expect(nextAction.matches(":disabled")).toBe(true); fireEvent.click(nextAction);
    fireEvent.submit(close.closest("form")!); expect(writes()).toHaveLength(1); expect(mocks.uuid).toHaveBeenCalledTimes(2);
    fireEvent.click(await enabled("Обновить после конфликта")); await confirmAction("Назначить основное подразделение"); await waitFor(() => expect(writes()).toHaveLength(2));
    expect(JSON.parse(writes()[1][1].body).expectedVersion).toBe(5); expect(writes()[1][1].headers["X-Action-Id"]).not.toBe(writes()[0][1].headers["X-Action-Id"]);
  });
  it("allows closing a known rejected command without locking a new explicit intent", async () => {
    mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (options?.method) throw failure(400); return defaults(url); });
    mount(); await selectBoth(); await confirmAction("Назначить руководителя"); await screen.findByText(/Изменение отклонено/);
    fireEvent.click(await enabled("Закрыть")); expect(screen.queryByRole("region", { name: "Подтверждение назначения" })).toBeNull();
    await confirmAction("Назначить основное подразделение"); await waitFor(() => expect(writes()).toHaveLength(2)); expect(JSON.parse(writes()[1][1].body).departmentId).toBe(department.id);
  });
  it("gates duplicate confirmation and all conflicting selection/navigation while pending", async () => {
    const pending = deferred<unknown>(); mocks.api.mockImplementation(async (url: string, options?: RequestInit) => options?.method ? pending.promise : defaults(url)); mount(); await selectBoth(); await confirmAction("Назначить руководителя");
    fireEvent.submit(screen.getByRole("button", { name: "Сохранение…" }).closest("form")!); expect(writes()).toHaveLength(1); expect(screen.getByRole("button", { name: "Выбрать сотрудника person-one" }).matches(":disabled")).toBe(true); expect(screen.getByRole("button", { name: "Корень" }).matches(":disabled")).toBe(true);
    await act(async () => { pending.resolve({ result: {}, version: 5, replayed: false }); });
  });
});

describe("assignment identity and cache boundaries", () => {
  it("hides data for a mismatched account before any read", () => { mocks.session.data.user.id = "other-admin"; mount(); expect(screen.getByText(/Данные назначений скрыты/)).toBeTruthy(); expect(reads()).toHaveLength(0); });
  it("cleans actor caches after403 and late sibling reads cannot recreate hidden data", async () => {
    const late = deferred<unknown>(); let revoked = false; mocks.api.mockImplementation(async (url: string) => !revoked ? defaults(url) : url.includes("/people?") ? late.promise : Promise.reject(failure(403)));
    const view = mount(); await selectBoth(); revoked = true; let refetch!: Promise<void>; await act(async () => { refetch = view.client.refetchQueries({ queryKey: ["adminAssignments", "admin"] }); }); await screen.findByText(/Данные назначений скрыты/);
    // The warning DOM can commit before passive effect/observer cache cleanup.
    await waitFor(() => expect(view.client.getQueriesData({ queryKey: ["adminAssignments", "admin"] })).toHaveLength(0));
    await act(async () => { late.resolve(page([{ ...person, displayName: "PRIVATE_LATE_PERSON" }])); await refetch; }); expect(view.client.getQueriesData({ queryKey: ["adminAssignments", "admin"] })).toHaveLength(0); expect(screen.queryByText(/PRIVATE_LATE/)).toBeNull();
    const reload = vi.fn(); vi.stubGlobal("window", new Proxy(window, { get(target, key) { return key === "location" ? { reload } : Reflect.get(target, key, target); } })); try { fireEvent.click(screen.getByRole("button", { name: "Обновить страницу" })); expect(reload).toHaveBeenCalledOnce(); } finally { vi.unstubAllGlobals(); }
  });
  it("does not revive an old account's confirmation or saved result after a pending write", async () => {
    const pending = deferred<unknown>(); mocks.api.mockImplementation(async (url: string, options?: RequestInit) => options?.method ? pending.promise : defaults(url)); const view = mount(); await selectBoth(); await confirmAction("Назначить руководителя");
    mocks.session.data.user.id = "other-admin"; view.rerenderActor("admin"); await screen.findByText(/Данные назначений скрыты/); await act(async () => { pending.resolve({ result: { leaderId: "PRIVATE_OLD_RESULT" }, version: 5, replayed: false }); });
    expect(screen.queryByRole("region", { name: "Подтверждение назначения" })).toBeNull(); await waitFor(() => expect(view.client.getQueriesData({ queryKey: ["adminAssignments", "admin"] })).toHaveLength(0)); expect(screen.queryByText(/PRIVATE_OLD/)).toBeNull(); view.rerenderActor("other-admin"); await enabled("Выбрать сотрудника person-one");
  });
  it("renders minimized fields and preserves all long names/IDs as text, without raw user fields", async () => {
    const longName = "С".repeat(120); mocks.api.mockImplementation(async (url: string) => url.includes("/people?") ? page([{ ...person, displayName: longName, email: "PRIVATE_EMAIL", passwordHash: "PRIVATE_HASH" }]) : { ...page([{ ...department, name: "Д".repeat(120) }]), parent: null });
    mount(); await enabled("Выбрать сотрудника person-one"); expect(screen.getByText(longName)).toBeTruthy(); expect(screen.queryByText(/PRIVATE_/)).toBeNull(); expect(screen.getByLabelText("Имя или ID")).toBeTruthy();
  });
});
