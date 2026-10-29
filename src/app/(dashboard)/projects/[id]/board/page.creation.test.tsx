import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ policy: vi.fn(), access: vi.fn(), status: vi.fn(), execution: vi.fn() }));
vi.mock("./ProjectBoardClient", () => ({ ProjectBoardClient: () => null }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: async () => ({ id: "applicant", globalRole: "USER" }) }));
vi.mock("@/lib/project-access", () => ({ requireProjectRead: mocks.access }));
vi.mock("@/lib/project-creation-policy", () => ({ getProjectCreationPolicy: mocks.policy }));
vi.mock("@/lib/project-status-policy", () => ({ getProjectStatusPolicy: mocks.status }));
vi.mock("@/lib/project-request-execution-policy", () => ({ getProjectRequestExecutionPolicy: mocks.execution }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("not found"); } }));
import Page from "./page";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({ canWrite: true, canManageMembers: false });
  mocks.status.mockResolvedValue({ canChangeStatus: false });
  mocks.execution.mockResolvedValue({ canExecute: true });
});
describe("board creation authority", () => {
  it("starts independent policies together after access has been granted", async () => {
    let resolve!: (value: { canCreate: boolean; allowedColumnIds: string[] }) => void;
    mocks.policy.mockReturnValue(new Promise(done => { resolve = done; }));
    const pending = Page({ params: Promise.resolve({ id: "board" }) });
    await vi.waitFor(() => expect(mocks.execution).toHaveBeenCalledWith("applicant", "board"));
    expect(mocks.status).toHaveBeenCalled();
    resolve({ canCreate: true, allowedColumnIds: ["new"] });
    expect((await pending).props.canExecuteRequests).toBe(true);
  });
  it("does not start policy reads before project access is checked", async () => {
    mocks.access.mockRejectedValue(Error("denied"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(Page({ params: Promise.resolve({ id: "board" }) })).rejects.toThrow("not found");
      expect(mocks.policy).not.toHaveBeenCalled();
      expect(mocks.status).not.toHaveBeenCalled();
      expect(mocks.execution).not.toHaveBeenCalled();
    } finally { consoleError.mockRestore(); }
  });
  it("does not use board write access as permission to create", async () => {
    mocks.policy.mockResolvedValue({ canCreate: false, allowedColumnIds: [] });
    const page = await Page({ params: Promise.resolve({ id: "board" }) });
    expect(page.props.canCreate).toBe(false);
    expect(page.props.allowedCreationColumnIds).toEqual([]);
  });
  it("passes the server initial-column restriction to the board", async () => {
    mocks.policy.mockResolvedValue({ canCreate: true, allowedColumnIds: ["new"] });
    const page = await Page({ params: Promise.resolve({ id: "board" }) });
    expect(page.props.canCreate).toBe(true);
    expect(page.props.allowedCreationColumnIds).toEqual(["new"]);
    expect(page.props.canChangeStatus).toBe(false);
    expect(page.props.canExecuteRequests).toBe(true);
  });
});
