import { describe, expect, it, vi } from "vitest";
vi.mock("./prisma", () => ({ prisma: {} }));
import { validateRequestRecipients } from "./request-audience-input";
import { ForbiddenError } from "./errors";
function fixture(departmentId: string | null = "department") {
  const query = vi.fn(async (_parts: TemplateStringsArray, ..._values: unknown[]) => { void _parts; void _values; return []; });
  const users = vi.fn().mockResolvedValue([{ id: "recipient" }]);
  const tx = { $queryRaw: query, project: { findUnique: vi.fn().mockResolvedValue({ departmentId, department: departmentId ? { id: departmentId, archivedAt: null } : null, responsibleGroupId: "group", responsibleGroup: { archivedAt: null } }) }, user: { findMany: users } };
  return { tx, query, users };
}
describe("creation recipients share the destination execution rule", () => {
  it("locks department and recipient User before matching current primaryDepartment", async () => {
    const f = fixture(); await validateRequestRecipients(f.tx as never, "board", ["recipient"]);
    expect(f.query.mock.calls.map(call => (call[0] as TemplateStringsArray).join("?"))).toEqual([expect.stringContaining('FROM "Department"'), expect.stringContaining('FROM "User"')]);
    expect(f.query.mock.invocationCallOrder.at(-1)).toBeLessThan(f.users.mock.invocationCallOrder[0]);
    expect(f.users).toHaveBeenCalledWith({ where: { AND: [{ primaryDepartmentId: "department", isBlocked: false, blockedAt: null }, { id: { in: ["recipient"] } }] }, select: { id: true } });
  });
  it("rejects recipients who no longer match the destination, without group fallback", async () => {
    const f = fixture(); f.users.mockResolvedValue([]); await expect(validateRequestRecipients(f.tx as never, "board", ["recipient"])).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("locks group membership and recipients on legacy boards", async () => {
    const f = fixture(null); await validateRequestRecipients(f.tx as never, "board", ["recipient"]);
    expect(f.query.mock.calls.map(call => (call[0] as TemplateStringsArray).join("?"))).toEqual([expect.stringContaining('FROM "ResponsibleGroup"'), expect.stringContaining('FROM "ResponsibleGroupMember"'), expect.stringContaining('FROM "User"')]);
  });
  it("does not perform recipient reads for general audience", async () => { const f = fixture(); await validateRequestRecipients(f.tx as never, "board", []); expect(f.query).not.toHaveBeenCalled(); expect(f.users).not.toHaveBeenCalled(); });
});
