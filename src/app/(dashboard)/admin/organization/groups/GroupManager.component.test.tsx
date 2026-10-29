import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationGroup, OrganizationPerson } from "@/lib/organization-contract";

const mocks = vi.hoisted(() => ({ api: vi.fn(), user: vi.fn(), notFound: vi.fn(), uuid: vi.fn(), session: { status: "authenticated", data: { user: { id: "admin", globalRole: "ADMIN" } } } }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("next-auth/react", () => ({ useSession: () => mocks.session }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: mocks.user, isGlobalAdmin: (user: { globalRole: string }) => user.globalRole === "ADMIN" }));
import GroupManager from "./GroupManager";
import GroupsPage, { dynamic } from "./page";

const endpoint = "/api/admin/organization/groups";
const group: OrganizationGroup = { id: "group-one", name: "Первая группа", archived: false };
const archivedGroup: OrganizationGroup = { id: "group-two", name: "Архивная группа", archived: true };
const member: OrganizationPerson = { id: "person-one", displayName: "Первый сотрудник", primaryDepartmentId: "department-a" };
const person: OrganizationPerson = { id: "person-two", displayName: "Второй сотрудник", primaryDepartmentId: "department-b" };
function page<T>(items: T[], version = 7, nextCursor: string | null = null) { return { items, version, nextCursor }; }
function params(url: string) { return new URL(url, "https://synthetic.invalid").searchParams; }
function error(status: number) { return Object.assign(new Error("PRIVATE_BACKEND_ERROR"), { status }); }
function reads() { return mocks.api.mock.calls.filter(([, options]) => !options?.method); }
function writes() { return mocks.api.mock.calls.filter(([, options]) => options?.method); }
function defaults(url: string) {
  if (url.endsWith('/leader')) return { result: { id: group.id, leaderId: null }, version: 7 };
  if (url.includes("/members?")) return { ...page([member]), group: url.includes("group-two") ? archivedGroup : group };
  if (url.includes("/people?")) return page([person]);
  return page([group, archivedGroup]);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const clients: QueryClient[] = [];
function mount(actorId = "admin", strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } } }); clients.push(client);
  const tree = (id: string) => { const content = <QueryClientProvider client={client}><GroupManager actorId={id} /></QueryClientProvider>; return strict ? <StrictMode>{content}</StrictMode> : content; };
  const view = render(tree(actorId)); return { client, ...view, rerenderActor: (id: string) => view.rerender(tree(id)) };
}
async function enabled(name: string) { const button = await screen.findByRole("button", { name }); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); return button; }
async function choose(name = group.name) { fireEvent.click(await enabled(name)); await enabled("Удалить из группы"); }
async function create(name = "Новая") { fireEvent.click(await enabled("Создать группу")); fireEvent.change(screen.getByLabelText("Название группы"), { target: { value: name } }); fireEvent.click(screen.getByRole("button", { name: "Сохранить" })); }
beforeEach(() => {
  mocks.api.mockReset(); mocks.user.mockReset(); mocks.notFound.mockReset(); mocks.uuid.mockReset(); mocks.session.status = "authenticated"; mocks.session.data.user = { id: "admin", globalRole: "ADMIN" };
  let sequence = 0; mocks.uuid.mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`); vi.stubGlobal("crypto", { randomUUID: mocks.uuid });
  mocks.notFound.mockImplementation(() => { throw new Error("NOT_FOUND_SENTINEL"); });
  mocks.api.mockImplementation(async (url: string, options?: RequestInit) => options?.method ? { result: group, version: 8, replayed: false } : defaults(url));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });

describe("groups server gate and identity", () => {
  it("is dynamic and renders only a fresh globalADMIN with an actor key", async () => {
    mocks.user.mockResolvedValue({ id: "current-admin", globalRole: "ADMIN" }); const element = await GroupsPage(); expect(dynamic).toBe("force-dynamic"); expect(element.type).toBe(GroupManager); expect(element.key).toBe("current-admin"); expect(element.props.actorId).toBe("current-admin"); expect(mocks.api).not.toHaveBeenCalled();
  });
  it("rejects USER and missing identity without client API reads", async () => {
    mocks.user.mockResolvedValueOnce({ id: "user", globalRole: "USER" }); await expect(GroupsPage()).rejects.toThrow("NOT_FOUND_SENTINEL"); mocks.user.mockRejectedValueOnce(new Error("Unauthorized")); await expect(GroupsPage()).rejects.toThrow("Unauthorized"); expect(mocks.api).not.toHaveBeenCalled();
  });
  it("does not query while the session is loading or belongs to a different account", () => {
    mocks.session.status = "loading"; const view = mount(); expect(screen.getByText("Проверка учётной записи…")).toBeTruthy(); expect(reads()).toHaveLength(0);
    mocks.session.status = "authenticated"; mocks.session.data.user.id = "other-admin"; view.rerenderActor("admin"); expect(screen.getByText(/Данные групп скрыты/)).toBeTruthy(); expect(reads()).toHaveLength(0);
  });
  it("clears all group/member/people caches on fresh403 and requests fullreload for recovery", async () => {
    const view = mount(); await choose(); mocks.api.mockRejectedValue(error(403)); await act(async () => { await view.client.refetchQueries({ queryKey: ["adminGroups", "admin"] }); }); await screen.findByText(/Данные групп скрыты/);
    // The access-loss DOM commits before passive observer cleanup and cache GC.
    // Assert the actual empty cache after that lifecycle, not just hidden rows.
    await waitFor(() => expect(view.client.getQueriesData({ queryKey: ["adminGroups", "admin"] })).toHaveLength(0)); expect(screen.queryByText(person.displayName!)).toBeNull();
    const reload = vi.fn(); vi.stubGlobal("window", new Proxy(window, { get(target, key) { return key === "location" ? { reload } : Reflect.get(target, key, target); } }));
    try { fireEvent.click(screen.getByRole("button", { name: "Обновить страницу" })); expect(reload).toHaveBeenCalledOnce(); } finally { vi.unstubAllGlobals(); }
  });
  it("ignores an old account's late mutation success without reviving editor or rows", async () => {
    const pending = deferred<unknown>(); mocks.api.mockImplementation(async (url: string, options?: RequestInit) => options?.method ? pending.promise : defaults(url));
    const view = mount(); await create("OLD_ACCOUNT_EDITOR"); mocks.session.data.user.id = "other-admin"; view.rerenderActor("admin"); await screen.findByText(/Данные групп скрыты/);
    await act(async () => { pending.resolve({ result: { name: "OLD_PRIVATE_RESULT" }, version: 8, replayed: false }); }); expect(screen.queryByText(/OLD_/)).toBeNull(); expect(screen.queryByRole("region", { name: "Изменение группы" })).toBeNull(); await waitFor(() => expect(view.client.getQueriesData({ queryKey: ["adminGroups", "admin"] })).toHaveLength(0));
    view.rerenderActor("other-admin"); await screen.findByRole("button", { name: group.name }); expect(screen.queryByDisplayValue("OLD_ACCOUNT_EDITOR")).toBeNull();
  });
  it("does not recreate cleared caches when sibling reads succeed late after another view loses access", async () => {
    const lateMembers = deferred<unknown>(), latePeople = deferred<unknown>();
    let revoked = false;
    mocks.api.mockImplementation(async (url: string) => {
      if (!revoked) return defaults(url);
      if (url.includes("/members?")) return lateMembers.promise;
      if (url.includes("/people?")) return latePeople.promise;
      throw error(403);
    });
    const view = mount(); await choose(); revoked = true;
    let refetch!: Promise<void>;
    await act(async () => { refetch = view.client.refetchQueries({ queryKey: ["adminGroups", "admin"] }); });
    await screen.findByText(/Данные групп скрыты/);
    await waitFor(() => expect(view.client.getQueriesData({ queryKey: ["adminGroups", "admin"] })).toHaveLength(0));
    await act(async () => {
      lateMembers.resolve({ ...page([{ ...member, displayName: "PRIVATE_LATE_MEMBER" }]), group });
      latePeople.resolve(page([{ ...person, displayName: "PRIVATE_LATE_PERSON" }]));
      await refetch;
    });
    expect(view.client.getQueriesData({ queryKey: ["adminGroups", "admin"] })).toHaveLength(0);
    expect(screen.queryByText(/PRIVATE_LATE/)).toBeNull(); expect(screen.queryByRole("region", { name: "Изменение группы" })).toBeNull();
  });
});

describe("groups, members and people reads", () => {
  it("keeps409 latched across Close, group selection, archive filter and people search", async () => {
    mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (options?.method) throw error(409); return defaults(url); });
    mount(); await choose(); await create(); await screen.findByText(/Конфликт версии или ограничений группы/);
    const beforeReads = reads().length;
    const close = screen.getByRole("button", { name: "Закрыть" }) as HTMLButtonElement;
    expect(close.disabled).toBe(true); fireEvent.click(close);
    for (const name of ["Создать группу", group.name, archivedGroup.name, "Найти", "Сбросить поиск"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true); fireEvent.click(button);
    }
    const filter = screen.getByLabelText("Архив групп") as HTMLSelectElement;
    expect(filter.disabled).toBe(true); fireEvent.change(filter, { target: { value: "archived" } });
    const search = screen.getByLabelText("Имя или ID") as HTMLInputElement;
    expect(search.disabled).toBe(true); fireEvent.change(search, { target: { value: "other" } }); fireEvent.submit(search.closest("form")!);
    expect(reads()).toHaveLength(beforeReads); expect(writes()).toHaveLength(1); expect(mocks.uuid).toHaveBeenCalledOnce();
    expect(screen.getByRole("region", { name: "Изменение группы" })).toBeTruthy();
    expect(screen.getByText(/Конфликт версии или ограничений группы/)).toBeTruthy();
  });
  it("survives StrictMode cleanup and loads bounded groups before secondary views", async () => {
    mount("admin", true); await enabled("Создать группу"); expect(reads().every(([url]) => !url.includes("members") && !url.includes("people"))).toBe(true); expect(params(reads()[0][0]).get("limit")).toBe("50");
    await choose(); expect(reads().some(([url]) => url.startsWith(`${endpoint}/group-one/members?`))).toBe(true); expect(screen.getByText(person.displayName!)).toBeTruthy(); expect(screen.getByText(/department-b/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Состав группы")));
  });
  it("changes the archive filter and resets selection and cursor pages", async () => {
    mount(); await choose(); fireEvent.change(screen.getByLabelText("Архив групп"), { target: { value: "archived" } }); await enabled("Создать группу");
    const request = reads().filter(([url]) => url.startsWith(endpoint + "?")).at(-1)!; expect(params(request[0]).get("archived")).toBe("archived"); expect(params(request[0]).has("cursor")).toBe(false); expect(screen.queryByLabelText("Состав группы")).toBeNull();
  });
  it.each(["Список групп", "Состав группы", "Сотрудники"])("retains %s rows on next-page failure and retries the same cursor", async label => {
    let failed = false;
    mocks.api.mockImplementation(async (url: string) => {
      const targeted = label === "Список групп" ? url.startsWith(endpoint + "?") : label === "Состав группы" ? url.includes("/members?") : url.includes("/people?");
      if (!targeted) return defaults(url);
      if (params(url).has("cursor")) { if (!failed) { failed = true; throw error(503); } return label === "Состав группы" ? { ...page([member]), group } : label === "Список групп" ? page([group]) : page([person]); }
      return label === "Состав группы" ? { ...page([member], 7, "cursor-one"), group } : label === "Список групп" ? page([group], 7, "cursor-one") : page([person], 7, "cursor-one");
    }); mount(); if (label !== "Список групп") await choose();
    fireEvent.click(await enabled(`Загрузить ещё: ${label}`)); await screen.findByRole("button", { name: `Повторить загрузку: ${label}` }); expect(screen.getByLabelText(label)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Повторить загрузку: ${label}` })); await waitFor(() => expect((screen.getByRole("button", { name: `Всё загружено: ${label}` }) as HTMLButtonElement).disabled).toBe(true));
    expect(reads().filter(([url]) => params(url).get("cursor") === "cursor-one")).toHaveLength(2); expect(screen.queryByText("PRIVATE_BACKEND_ERROR")).toBeNull();
  });
  it("disables writes and hides every list on cross-view version mismatch, then refreshes all", async () => {
    let mismatch = true; mocks.api.mockImplementation(async (url: string) => url.includes("/people?") && mismatch ? page([person], 8) : defaults(url)); mount();
    fireEvent.click(await enabled(group.name)); await screen.findByText(/Версии структуры различаются/); expect(screen.queryByLabelText("Список групп")).toBeNull(); expect(screen.queryByLabelText("Сотрудники")).toBeNull(); expect(writes()).toHaveLength(0);
    mismatch = false; fireEvent.click(await enabled("Загрузить актуальные списки")); await enabled("Удалить из группы"); expect(screen.getByLabelText("Список групп")).toBeTruthy();
  });
  it("treats stale membership cursors409 as an explicit refresh instead of mixing pages", async () => {
    mocks.api.mockImplementation(async (url: string) => url.includes("/members?") ? params(url).has("cursor") ? Promise.reject(error(409)) : { ...page([member], 7, "stale"), group } : defaults(url));
    mount(); await choose(); fireEvent.click(await enabled("Загрузить ещё: Состав группы")); await screen.findByText(/Версии структуры различаются/); expect(screen.queryByText(member.displayName!)).toBeNull(); expect(screen.queryByRole("button", { name: "Удалить из группы" })).toBeNull();
  });
  it("normalizes people search and restarts first-page cursors for repeated and cached queries", async () => {
    mocks.api.mockImplementation(async (url: string) => url.includes("/people?") ? page([person], 7, "people-next") : defaults(url)); mount(); await choose();
    fireEvent.click(await enabled("Загрузить ещё: Сотрудники")); await waitFor(() => expect(reads().some(([url]) => params(url).has("cursor"))).toBe(true));
    for (const q of ["  ALICE  ", "", "ALICE", "ALICE"]) {
      const before = reads().filter(([url]) => url.includes("/people?")).length;
      fireEvent.change(screen.getByLabelText("Имя или ID"), { target: { value: q } }); fireEvent.click(screen.getByRole("button", { name: "Найти" }));
      await waitFor(() => expect(reads().filter(([url]) => url.includes("/people?")).length).toBeGreaterThan(before));
      const latest = reads().filter(([url]) => url.includes("/people?")).at(-1)![0]; expect(params(latest).get("q")).toBe(q.trim() ? "alice" : null); expect(params(latest).has("cursor")).toBe(false);
    }
  });
  it("does not render email, auth fields or unnamed-person fallback as email", async () => {
    mocks.api.mockImplementation(async (url: string) => url.includes("/people?") ? page([{ ...person, displayName: null, email: "PRIVATE_EMAIL", passwordHash: "PRIVATE_HASH" }]) : defaults(url));
    mount(); await choose(); expect(screen.getByText("Имя не указано")).toBeTruthy(); expect(screen.queryByText(/PRIVATE_/)).toBeNull();
  });
});

describe("group and membership commands", () => {
  it.each(["create", "rename", "archive", "restore"])("submits closed %s payload with the authoritative group version", async kind => {
    mount(); await enabled("Создать группу");
    if (kind === "create") await create("  Новая  ");
    else {
      const item = screen.getByRole("button", { name: kind === "restore" ? archivedGroup.name : group.name }).closest("li")!;
      fireEvent.click(within(item).getByRole("button", { name: kind === "rename" ? "Переименовать" : kind === "restore" ? "Восстановить" : "Архивировать" }));
      if (kind === "rename") fireEvent.change(screen.getByLabelText("Название группы"), { target: { value: " Новая " } });
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    }
    await waitFor(() => expect(writes()).toHaveLength(1)); const body = JSON.parse(writes()[0][1].body);
    expect(body.expectedVersion).toBe(7); expect(body.operationId).toMatch(/000000000001$/);
    const { operationId: _id, expectedVersion: _version, ...payload } = body; void _id; void _version;
    expect(payload).toEqual(kind === "create" ? { name: "Новая" } : kind === "rename" ? { kind: "rename", name: "Новая" } : { kind: "archive", archived: kind === "archive" });
  });
  it("adds a person from a different department using only userId and no optimistic membership toggle", async () => {
    const pending = deferred<unknown>(); mocks.api.mockImplementation(async (url: string, options?: RequestInit) => options?.method ? pending.promise : defaults(url)); mount(); await choose();
    fireEvent.click(await enabled("Добавить в группу")); fireEvent.click(screen.getByRole("button", { name: "Сохранить" })); await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][0]).toBe(`${endpoint}/group-one/members`); expect(JSON.parse(writes()[0][1].body)).toEqual({ userId: person.id, member: true, operationId: "00000000-0000-4000-8000-000000000001", expectedVersion: 7 });
    expect(within(screen.getByLabelText("Состав группы")).queryByText(person.displayName!)).toBeNull();
    await act(async () => { pending.resolve({ result: { groupId: group.id, userId: person.id, member: true }, version: 8, replayed: false }); });
  });
  it("permits removal from an archived group but rejects add and rename in the UI", async () => {
    mount(); await choose(archivedGroup.name); expect((screen.getByRole("button", { name: "Добавить в группу" }) as HTMLButtonElement).disabled).toBe(true);
    const item = screen.getByRole("button", { name: archivedGroup.name }).closest("li")!; expect((within(item).getByRole("button", { name: "Переименовать" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await enabled("Удалить из группы")); fireEvent.click(screen.getByRole("button", { name: "Сохранить" })); await waitFor(() => expect(writes()).toHaveLength(1)); expect(JSON.parse(writes()[0][1].body).member).toBe(false); expect(writes()[0][0]).toContain("group-two/members");
  });
  it.each(["network", "5xx"])("retries an unknown %s result with the identical immutable command body", async failure => {
    let attempts = 0, readVersion = 7; mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (!options?.method) return { ...defaults(url), version: readVersion }; if (++attempts === 1) throw failure === "network" ? new TypeError("private network") : error(503); return { result: { name: "PRIVATE_SAVED_SNAPSHOT" }, version: 1, replayed: true }; });
    const view = mount(); await choose(); fireEvent.click(await enabled("Добавить в группу")); fireEvent.click(screen.getByRole("button", { name: "Сохранить" })); await screen.findByText(/Результат неизвестен/);
    readVersion = 8; await act(async () => { await view.client.refetchQueries({ queryKey: ["adminGroups", "admin"] }); });
    expect((screen.getByLabelText("Имя или ID") as HTMLInputElement).disabled).toBe(true); fireEvent.click(screen.getByRole("button", { name: "Повторить ту же операцию" })); await screen.findByText(/Ранее сохранённая операция подтверждена/);
    expect(writes()).toHaveLength(2); expect(writes()[0][1].body).toBe(writes()[1][1].body); expect(mocks.uuid).toHaveBeenCalledOnce(); expect(screen.queryByText("PRIVATE_SAVED_SNAPSHOT")).toBeNull();
  });
  it("requires explicit refresh and a new intent after409 without silently changing expectedVersion", async () => {
    let version = 7, attempts = 0; mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (!options?.method) return { ...defaults(url), version }; if (++attempts === 1) { version = 8; throw error(409); } return { result: group, version: 9, replayed: false }; });
    mount(); await create(); await screen.findByText(/Конфликт версии или ограничений/); expect(writes()).toHaveLength(1); expect(screen.queryByRole("button", { name: "Повторить ту же операцию" })).toBeNull();
    fireEvent.click(await enabled("Обновить после конфликта")); await create("Другая"); await waitFor(() => expect(writes()).toHaveLength(2)); const a = JSON.parse(writes()[0][1].body), b = JSON.parse(writes()[1][1].body); expect(b.expectedVersion).toBe(8); expect(b.operationId).not.toBe(a.operationId);
  });
  it("keeps committed success separate from all failed read refreshes without replaying a mutation", async () => {
    let committed = false; mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (options?.method) { committed = true; return { result: group, version: 8, replayed: false }; } if (committed) throw error(503); return defaults(url); });
    mount(); await choose(); fireEvent.click(await enabled("Удалить из группы")); fireEvent.click(screen.getByRole("button", { name: "Сохранить" })); await screen.findByText(/Изменение сохранено/);
    await screen.findByRole("button", { name: "Повторить загрузку: Состав группы" }); expect(screen.getByText(member.displayName!)).toBeTruthy(); expect(screen.queryByText(/Результат неизвестен/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку: Состав группы" })); await waitFor(() => expect(reads().length).toBeGreaterThan(6)); expect(writes()).toHaveLength(1);
  });
  it("uses one pending gate for membership, group actions, search and duplicate submits", async () => {
    const pending = deferred<unknown>(); mocks.api.mockImplementation(async (url: string, options?: RequestInit) => options?.method ? pending.promise : defaults(url)); mount(); await choose();
    fireEvent.click(await enabled("Удалить из группы")); fireEvent.click(screen.getByRole("button", { name: "Сохранить" })); const form = screen.getByRole("button", { name: "Сохранение…" }).closest("form")!; fireEvent.submit(form); expect(writes()).toHaveLength(1); expect((screen.getByRole("button", { name: group.name }) as HTMLButtonElement).disabled).toBe(true); expect((screen.getByRole("button", { name: "Найти" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { pending.resolve({ result: group, version: 8, replayed: false }); });
  });
});
