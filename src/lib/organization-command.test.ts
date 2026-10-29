import { describe, expect, it, vi } from "vitest";
import {
  decodeOrganizationResult, normalizeOrganizationActor, organizationRequestHash,
  ORGANIZATION_MAX_VERSION, type OrganizationMethod,
} from "./organization-command";

const operationId = "a1234567-1234-4123-8123-123456789abc";
const department = { id: "dept", name: "Department", parentId: null, leaderId: "leader", archived: false };
const cases: [OrganizationMethod, object][] = [
  ["createBoard", { id: "board", departmentId: "dept", responsibleGroupId: null }],
  ...(["createDepartment", "renameDepartment", "moveDepartment", "setDepartmentArchived", "setDepartmentLeader"] as const)
    .map(method => [method, department] as [OrganizationMethod, object]),
  ...(["createGroup", "renameGroup", "setGroupArchived"] as const)
    .map(method => [method, { id: "group", name: "Group", archived: true }] as [OrganizationMethod, object]),
  ["assignUserDepartment", { id: "user", primaryDepartmentId: null }],
  ["setGroupMember", { groupId: "group", userId: "user", member: false }],
  ["bindProject", { id: "board", departmentId: "dept", responsibleGroupId: null }],
];

describe("organization command metadata and saved-result boundary", () => {
  it("normalizes UUID case and accepts both version boundaries without copying caller fields", () => {
    for (const expectedVersion of [0, ORGANIZATION_MAX_VERSION]) {
      expect(normalizeOrganizationActor({ actorId: "admin", operationId: operationId.toUpperCase(), expectedVersion,
        globalRole: "ADMIN" } as Parameters<typeof normalizeOrganizationActor>[0]))
        .toEqual({ actorId: "admin", operationId, expectedVersion });
    }
  });
  it.each([undefined, null, "", "operation-1", "https://secret.invalid", 12])("rejects malformed operation IDs %j", value => {
    expect(() => normalizeOrganizationActor({ actorId: "admin", operationId: value as string, expectedVersion: 0 }))
      .toThrowError(expect.objectContaining({ name: "ValidationError" }));
  });
  it.each([-1, 0.5, NaN, Infinity, ORGANIZATION_MAX_VERSION + 1, "0", null, undefined])("rejects invalid version %j", value => {
    expect(() => normalizeOrganizationActor({ actorId: "admin", operationId, expectedVersion: value as number }))
      .toThrowError(expect.objectContaining({ name: "ValidationError" }));
  });
  it("hashes normalized command semantics independently of object insertion order", () => {
    const first = organizationRequestHash("bindProject", "board", { departmentId: "dept", responsibleGroupId: null }, 3);
    const reordered = organizationRequestHash("bindProject", "board", { responsibleGroupId: null, departmentId: "dept" }, 3);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(reordered);
    for (const other of [
      organizationRequestHash("bindProject", "board", { departmentId: null, responsibleGroupId: null }, 3),
      organizationRequestHash("bindProject", "other", { departmentId: "dept", responsibleGroupId: null }, 3),
      organizationRequestHash("bindProject", "board", { departmentId: "dept", responsibleGroupId: null }, 4),
      organizationRequestHash("renameGroup", "board", { departmentId: "dept", responsibleGroupId: null }, 3),
    ]) expect(other).not.toBe(first);
  });
  it.each(cases)("decodes only the closed JSON result for %s into a fresh object", (method, result) => {
    const input = Object.freeze({ ...result });
    const decoded = decodeOrganizationResult(method, input);
    expect(decoded).toEqual(result);
    expect(decoded).not.toBe(input);
  });
  it.each(cases)("rejects a privileged extra persisted field on %s", (method, result) => {
    expect(() => decodeOrganizationResult(method, { ...result, passwordHash: "synthetic-secret" }))
      .toThrowError(expect.objectContaining({ name: "ConflictError" }));
  });
  it.each([
    null, [], { ...department, archived: "false" }, { ...department, parentId: 0 },
    { ...department, name: " Department " }, { ...department, id: "bad/id" },
    { id: "dept", name: "Department", parentId: null, archived: false },
    { ...department, archivedAt: "2026-10-20T00:00:00.000Z" },
    { ...department, name: "" },
  ])("rejects corrupted department receipts without returning stored content %j", result => {
    expect(() => decodeOrganizationResult("renameDepartment", result))
      .toThrowError(expect.objectContaining({ name: "ConflictError", message: "Invalid saved organization operation" }));
  });
  it("does not evaluate saved-result getters or leak hostile exception messages", () => {
    const getter = vi.fn(() => { throw Error("synthetic credential"); });
    const result = { ...department };
    Object.defineProperty(result, "name", { enumerable: true, get: getter });
    expect(() => decodeOrganizationResult("renameDepartment", result))
      .toThrowError(expect.objectContaining({ name: "ConflictError", message: "Invalid saved organization operation" }));
    expect(getter).not.toHaveBeenCalled();
    const proxy = new Proxy({}, { ownKeys() { throw Error("synthetic credential"); } });
    expect(() => decodeOrganizationResult("renameDepartment", proxy))
      .toThrowError(expect.objectContaining({ message: "Invalid saved organization operation" }));
  });
  it("rejects event/type mismatch and unsupported persisted operations", () => {
    expect(() => decodeOrganizationResult("bindProject", department)).toThrowError(expect.objectContaining({ name: "ConflictError" }));
    expect(() => decodeOrganizationResult("unknown" as OrganizationMethod, department)).toThrowError(expect.objectContaining({ name: "ConflictError" }));
  });
});
