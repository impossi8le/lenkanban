import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn(), session: { status: "authenticated", data: { user: { id: "admin", globalRole: "ADMIN" } } } }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("next-auth/react", () => ({ useSession: () => mocks.session }));
import RoleAssignmentManager from "./RoleAssignmentManager";

const clients: QueryClient[] = [];
let version = 7;
function response(url: string) {
  let items: unknown[] = [];
  if (url.includes("/privilege-profiles")) items = [{ id: "executor", name: "Исполнитель", permissions: ["request.execute"], visibility: "board", archived: false }];
  else if (url.includes("/groups?")) items = [{ id: "it", name: "ИТ поддержка", archived: false }];
  else if (url.includes("/departments?")) items = [{ id: "support", name: "Поддержка", archived: false, parentId: null, leaderId: null }];
  else if (url.includes("/people?")) items = [{ id: "ivan", displayName: "Иван Иванов", primaryDepartmentId: "support" }];
  return { items, nextCursor: null, version };
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } } }); clients.push(client);
  return render(<QueryClientProvider client={client}><RoleAssignmentManager actorId="admin" /></QueryClientProvider>);
}
async function enabled(name: string) { const button = await screen.findByRole("button", { name }); await waitFor(() => expect(button).not.toBeDisabled()); return button; }
async function prepare(personal = false) {
  await enabled("Исполнитель");
  if (personal) fireEvent.change(screen.getByLabelText("Источник назначения"), { target: { value: "personal" } });
  fireEvent.click(await enabled(personal ? "Иван Иванов · ivan" : "ИТ поддержка"));
  fireEvent.click(await enabled("Исполнитель"));
  fireEvent.change(screen.getByLabelText("Область роли"), { target: { value: "department" } });
  fireEvent.click(await enabled("Поддержка"));
  fireEvent.click(await enabled("Подготовить назначение роли"));
}
function writes() { return mocks.api.mock.calls.filter(([, options]) => options?.method); }
beforeEach(() => {
  version = 7; mocks.api.mockReset(); mocks.session.status = "authenticated"; mocks.session.data.user = { id: "admin", globalRole: "ADMIN" };
  let uuid = 0; vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (options?.method) { version++; return { result: {}, version, replayed: false }; } return response(url); });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });

describe("group and personal reusable roles", () => {
  it.each([false, true])("assigns a named scoped role (personal=%s) without global role changes", async personal => {
    mount(); await prepare(personal);
    const panel = screen.getByRole("region", { name: "Подтверждение роли" });
    expect(within(panel).getByText(`${personal ? "Иван Иванов" : "ИТ поддержка"} → Исполнитель → Поддержка`)).toBeTruthy();
    expect(writes()).toHaveLength(0);
    fireEvent.click(await enabled("Подтвердить роль"));
    await screen.findByText("Назначение сохранено.");
    const [url, options] = writes()[0];
    expect(url).toBe(`/api/admin/organization/${personal ? "privilege-assignments" : "group-privilege-assignments"}`);
    expect(JSON.parse(options.body)).toEqual({ [personal ? "userId" : "groupId"]: personal ? "ivan" : "it", profileId: "executor", scopeKind: "department", departmentId: "support", projectId: null, assigned: true, expectedVersion: 7, operationId: expect.any(String) });
    expect(writes()).toHaveLength(1);
  });
  it("retries unknown results with the identical command and action ID", async () => {
    let attempts = 0;
    mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (!options?.method) return response(url); if (++attempts === 1) throw Object.assign(new Error("PRIVATE"), { status: 503 }); version = 8; return { result: {}, version, replayed: true }; });
    mount(); await prepare(); fireEvent.click(await enabled("Подтвердить роль"));
    fireEvent.click(await enabled("Повторить ту же операцию"));
    await screen.findByText("Ранее сохранённая операция подтверждена.");
    expect(writes()).toHaveLength(2); expect(writes()[0][1]).toEqual(writes()[1][1]); expect(screen.queryByText("PRIVATE")).toBeNull();
  });
  it("latches conflict until explicit refresh and clears its stale confirmation", async () => {
    mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (!options?.method) return response(url); version = 8; throw Object.assign(new Error("PRIVATE"), { status: 409 }); });
    mount(); await prepare(); fireEvent.click(await enabled("Подтвердить роль"));
    await screen.findByText("Конфликт версии. Обновите данные и подготовьте действие заново.");
    expect(screen.getByLabelText("Источник назначения")).toBeDisabled(); expect(screen.getByRole("button", { name: "Закрыть" })).toBeDisabled();
    fireEvent.click(await enabled("Обновить данные ролей")); await enabled("Исполнитель");
    expect(screen.queryByRole("region", { name: "Подтверждение роли" })).toBeNull(); expect(writes()).toHaveLength(1);
  });
  it("hides mixed version snapshots and prevents mutations", async () => {
    mocks.api.mockImplementation(async (url: string) => ({ ...response(url), version: url.includes("/groups?") ? 8 : 7 }));
    mount(); await screen.findByText("Версии данных различаются. Обновите данные ролей перед изменениями."); expect(screen.queryByLabelText("Источник назначения")).toBeNull(); expect(writes()).toHaveLength(0);
  });
  it("hides sensitive forms after a forbidden mutation", async () => {
    mocks.api.mockImplementation(async (url: string, options?: RequestInit) => { if (options?.method) throw Object.assign(new Error("PRIVATE"), { status: 403 }); return response(url); });
    mount(); await prepare(); fireEvent.click(await enabled("Подтвердить роль")); await screen.findByText("Учётная запись или права изменились. Назначения скрыты."); expect(screen.queryByRole("region", { name: "Подтверждение роли" })).toBeNull();
  });
  it("does not read for a non-admin or a different actor", () => { mocks.session.data.user.globalRole = "USER"; mount(); expect(mocks.api).not.toHaveBeenCalled(); });
  it("revokes only the selected group assignment", async () => {
    mocks.api.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method) { version++; return { result: {}, version, replayed: false }; }
      if (url.includes("/group-privilege-assignments?")) return { items: [{ id: "grant", groupId: "it", profileId: "executor", scopeKind: "organization", departmentId: null, projectId: null, assigned: true }], nextCursor: null, version };
      return response(url);
    });
    mount(); fireEvent.click(await enabled("ИТ поддержка")); fireEvent.click(await enabled("Отозвать роль Исполнитель")); fireEvent.click(await enabled("Подтвердить роль"));
    await screen.findByText("Назначение сохранено."); expect(JSON.parse(writes()[0][1].body)).toMatchObject({ groupId: "it", profileId: "executor", assigned: false, scopeKind: "organization" });
  });
});
