import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), log: vi.fn(),
  template: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  project: { findFirst: vi.fn(), create: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: { projectTemplate: mocks.template, project: mocks.project } }));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.auth,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: mocks.log } }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));

import { GET as listTemplates, POST as saveTemplate } from "./route";
import { POST as applyTemplate } from "./[id]/use/route";
import {
  canUseProjectTemplate,
  readProjectTemplateAvailability,
} from "./template-availability";

function request(body?: unknown) {
  return new Request("http://localhost/api/project-templates", {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}
const params = () => ({ params: Promise.resolve({ id: "template-1" }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ id: "admin-1", globalRole: "ADMIN" });
  mocks.template.findMany.mockResolvedValue([]);
  mocks.template.create.mockResolvedValue({ id: "template-new" });
  mocks.template.findUnique.mockResolvedValue({
    createdById: "other-creator",
    templateData: { columns: [], tags: [], availability: "organization" },
  });
  mocks.project.findFirst.mockResolvedValue({ id: "project-1", columns: [], tags: [] });
  mocks.project.create.mockResolvedValue({ id: "board-1" });
});

describe("stored template availability", () => {
  it.each([
    [{ availability: "organization" }, "organization"],
    [{ availability: "creator" }, "creator"],
    [{ availability: "everyone" }, "creator"],
    [{ availability: 7 }, "creator"],
    [{}, "creator"],
    [null, "creator"],
    [[], "creator"],
    ["organization", "creator"],
  ])("reads %j as %s", (templateData, expected) => {
    expect(readProjectTemplateAvailability(templateData)).toBe(expected);
  });

  it("lets the creator use any own template but others only shared ones", () => {
    expect(canUseProjectTemplate({ createdById: "creator", templateData: {} }, "creator")).toBe(true);
    expect(canUseProjectTemplate({ createdById: "creator", templateData: {} }, "admin-1")).toBe(false);
    expect(canUseProjectTemplate({ createdById: "creator", templateData: { availability: "organization" } }, "admin-1")).toBe(true);
  });
});

describe("template availability is configured explicitly", () => {
  it("defaults to creator-only and stores the explicit organization choice", async () => {
    expect((await saveTemplate(request({ name: "Template", projectId: "project-1" }))).status).toBe(201);
    expect(mocks.template.create.mock.calls[0][0].data.templateData.availability).toBe("creator");
    expect((await saveTemplate(request({ name: "Template", projectId: "project-1", availability: "organization" }))).status).toBe(201);
    expect(mocks.template.create.mock.calls[1][0].data.templateData.availability).toBe("organization");
  });

  it.each(["everyone", null, 7, []])("rejects unknown availability %j", async (availability) => {
    expect((await saveTemplate(request({ name: "Template", projectId: "project-1", availability }))).status).toBe(400);
    expect(mocks.template.create).not.toHaveBeenCalled();
  });

  it("lists only the support preset for an administrator", async () => {
    expect((await listTemplates(request())).status).toBe(200);
    expect(mocks.template.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [{ id: "builtin-project-template-tech-support" }, { OR: [
      { createdById: "admin-1" },
      { templateData: { path: ["availability"], equals: "organization" } },
    ] }] } }));
  });

  it("offers the support preset to an ordinary employee", async () => {
    mocks.auth.mockResolvedValue({ id: "user-1", globalRole: "USER" });
    expect((await listTemplates(request())).status).toBe(200);
    expect(mocks.template.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [{ id: "builtin-project-template-tech-support" }, { createdById: "user-1" }] } }));
  });

  it("denies using another creator's template that was not shared", async () => {
    mocks.template.findUnique.mockResolvedValue({ createdById: "other-creator", templateData: { columns: [], tags: [] } });
    expect((await applyTemplate(request({ projectName: "Board" }), params())).status).toBe(403);
    expect(mocks.project.create).not.toHaveBeenCalled();
  });
});
