import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createSourceFile, getModifiers, isFunctionDeclaration, ScriptTarget, SyntaxKind } from "typescript";
const api = vi.hoisted(() => ({ apiFetch: vi.fn(), apiPatch: vi.fn(), apiPost: vi.fn() }));
vi.mock("@/lib/api", () => api);
import { patchScalarCommand, type ScalarCommand } from "@/lib/task-scalar-transport";
const command: ScalarCommand = { taskId: "task", projectId: "project", actionId: "11111111-1111-4111-8111-111111111111",
  body: { operationId: "22222222-2222-4222-8222-222222222222", expectedVersion: 7, changes: { description: "original intent" } } };
const metadata = { taskId: "task", projectId: "project", marked: true, deleted: false, version: 99 };
it("checks the actual route export contract: lifecycle metadata is GET-only and task root accepts POST", () => {
  const exports = (filename: string) => createSourceFile(filename, readFileSync(filename, "utf8"), ScriptTarget.Latest, true).statements
    .filter(isFunctionDeclaration).filter(node => getModifiers(node)?.some(modifier => modifier.kind === SyntaxKind.ExportKeyword)).map(node => node.name?.text);
  expect(exports("src/app/api/tasks/[id]/route.ts")).toContain("POST");
  expect(exports("src/app/api/tasks/[id]/lifecycle/route.ts")).toContain("GET");
  expect(exports("src/app/api/tasks/[id]/lifecycle/route.ts")).not.toContain("POST");
});
beforeEach(() => { vi.resetAllMocks(); api.apiFetch.mockResolvedValue(metadata); });
it("dispatches only description to lifecycle using the exact original intent, never fresh metadata version", async () => {
  const ack = { taskId: "task", projectId: "project", version: 8, changed: true, replayed: false }; api.apiPost.mockResolvedValue(ack);
  expect(await patchScalarCommand(command)).toBe(ack);
  expect(api.apiFetch).toHaveBeenCalledExactlyOnceWith("/api/tasks/task/lifecycle", { method: "GET", cache: "no-store" }, { actionId: command.actionId });
  expect(api.apiPost).toHaveBeenCalledExactlyOnceWith("/api/tasks/task", { operationId: command.body.operationId, expectedVersion: 7, action: "edit_description", description: "original intent" }, { actionId: command.actionId, operationId: command.body.operationId });
  expect(api.apiPatch).not.toHaveBeenCalled();
});
it("keeps explicit legacy descriptions on the same scalar PATCH", async () => {
  api.apiFetch.mockResolvedValue({ ...metadata, marked: false }); await patchScalarCommand(command);
  expect(api.apiPatch).toHaveBeenCalledExactlyOnceWith("/api/tasks/task", command.body, { actionId: command.actionId, operationId: command.body.operationId }); expect(api.apiPost).not.toHaveBeenCalled();
});
it.each([null, {}, { ...metadata, taskId: "foreign" }, { ...metadata, projectId: "foreign" }, { ...metadata, marked: "true" }, { ...metadata, deleted: undefined }, { ...metadata, deleted: true }])("never writes on invalid/deleted lifecycle metadata %j", async value => {
  api.apiFetch.mockResolvedValue(value); await expect(patchScalarCommand(command)).rejects.toMatchObject({ status: 409 });
  expect(api.apiPatch).not.toHaveBeenCalled(); expect(api.apiPost).not.toHaveBeenCalled();
});
it.each([401, 403, 404, 503])("preserves lookup denial/failure %s without fallback", async status => {
  const error = Object.assign(Error("PRIVATE"), { status }); api.apiFetch.mockRejectedValue(error);
  await expect(patchScalarCommand(command)).rejects.toBe(error); expect(api.apiPost).not.toHaveBeenCalled(); expect(api.apiPatch).not.toHaveBeenCalled();
});
it.each([{ priority: "LOW" }, { description: "value", priority: "LOW" }, { description: "value", title: "title" }, { deadline: null }])("does not redirect mixed or other scalar changes %j", async changes => {
  const mixed = { ...command, body: { ...command.body, changes } }; await patchScalarCommand(mixed);
  expect(api.apiFetch).not.toHaveBeenCalled(); expect(api.apiPost).not.toHaveBeenCalled(); expect(api.apiPatch).toHaveBeenCalledExactlyOnceWith("/api/tasks/task", mixed.body, { actionId: command.actionId, operationId: command.body.operationId });
});
it("re-reads dispatch metadata on exact retry, retaining intent UUID/version without fallback", async () => {
  api.apiPost.mockRejectedValueOnce(new TypeError("PRIVATE")); await expect(patchScalarCommand(command)).rejects.toBeInstanceOf(TypeError);
  api.apiPost.mockResolvedValueOnce({ replayed: true }); await patchScalarCommand(command);
  expect(api.apiFetch).toHaveBeenCalledTimes(2); expect(api.apiPost.mock.calls[0]).toEqual(api.apiPost.mock.calls[1]); expect(api.apiPatch).not.toHaveBeenCalled();
});
it.each([Object.create(metadata), Object.defineProperty({ ...metadata }, "marked", { get() { throw Error("PRIVATE"); } }), new Proxy({}, { getOwnPropertyDescriptor() { throw Error("PRIVATE"); } })])("rejects inherited/getter/hostile lifecycle metadata without fallback", async value => {
  api.apiFetch.mockResolvedValue(value); await expect(patchScalarCommand(command)).rejects.toMatchObject({ status: 409, message: "INVALID_LIFECYCLE_METADATA" });
  expect(api.apiPost).not.toHaveBeenCalled(); expect(api.apiPatch).not.toHaveBeenCalled();
});
it("keeps the original expectedVersion and operation UUID if fresh retry metadata changes from legacy to marked", async () => {
  api.apiFetch.mockResolvedValueOnce({ ...metadata, marked: false }).mockResolvedValueOnce(metadata);
  api.apiPatch.mockRejectedValueOnce(new TypeError("PRIVATE")); await expect(patchScalarCommand(command)).rejects.toBeInstanceOf(TypeError);
  const conflict = Object.assign(Error("CONFLICT"), { status: 409 }); api.apiPost.mockRejectedValueOnce(conflict);
  await expect(patchScalarCommand(command)).rejects.toBe(conflict);
  expect(api.apiPost.mock.calls[0][1]).toMatchObject({ expectedVersion: 7, operationId: command.body.operationId }); expect(api.apiPatch).toHaveBeenCalledOnce();
});

it("reports only the actual lifecycle write, never the metadata probe", async () => {
  const onResult = vi.fn(); await patchScalarCommand({ ...command, onResult });
  expect(api.apiFetch.mock.calls[0][2]).toEqual({ actionId: command.actionId });
  expect(api.apiPost.mock.calls[0][2]).toEqual({ actionId: command.actionId, operationId: command.body.operationId, onResult });
});
it("preserves the write result callback on scalar PATCH", async () => {
  const onResult = vi.fn(); await patchScalarCommand({ ...command, body: { ...command.body, changes: { title: "Synthetic" } }, onResult });
  expect(api.apiPatch.mock.calls[0][2]).toEqual({ actionId: command.actionId, operationId: command.body.operationId, onResult });
});
