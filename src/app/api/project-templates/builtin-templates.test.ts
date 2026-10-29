import { beforeEach, describe, expect, it, vi } from "vitest";
import { readProjectTemplates } from "@/lib/project-template-loader";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), requireApiUser: vi.fn(), rateLimit: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  projectTemplate: { findUnique: mocks.findUnique, findMany: mocks.findMany }, project: { create: mocks.create },
} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn() } }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.requireApiUser,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitOrThrowKey: mocks.rateLimit, rateLimitErrorResponse: vi.fn(),
}));
import { POST } from "./[id]/use/route";
import { GET } from "./route";
import { SUPPORT_TEMPLATE_ID } from "@/lib/project-template-catalog";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireApiUser.mockResolvedValue({ id: "admin", globalRole: "ADMIN" });
  mocks.create.mockResolvedValue({ id: "created-board" });
});

function request(projectDescription?: string | null) {
  return new Request("http://localhost/api/project-templates/builtin/use", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectName: "Новая доска", projectDescription }),
  });
}

describe("built-in template use through the existing board creator (mock Prisma)", () => {
  it("lists only support even if the database still contains retired templates", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "builtin-project-template-it-requests", name: "Old IT", templateData: { key: "it-requests" } },
      { id: "custom-template", name: "Custom" },
    ]);
    const response = await GET(new Request("http://localhost/api/project-templates"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]).toMatchObject({ id: SUPPORT_TEMPLATE_ID, name: "Техподдержка и ИТ" });
  });

  it("creates support without requiring a seed run", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect((await POST(request(), { params: Promise.resolve({ id: SUPPORT_TEMPLATE_ID }) })).status).toBe(201);
    expect(mocks.create.mock.calls[0][0].data.columns.create.map((column: { name: string }) => column.name))
      .toEqual(["Новые", "В работе", "Ждём сотрудника", "Решено", "Закрыто"]);
  });

  it.each(["advertising", "autodial-off", "it-requests", "legal", "partners", "quality-claims",
    "receipt-requests", "shift-handover", "staff-reports", "telemarketing-handover"])(
    "denies direct use of the retired %s preset even by its creator", async key => {
      const id = `builtin-project-template-${key}`;
      mocks.findUnique.mockResolvedValue({ id, createdById: "admin", templateData: { key, availability: "organization" } });
      expect((await POST(request(), { params: Promise.resolve({ id }) })).status).toBe(403);
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it("creates the correct ordered columns, final DONE and description hint for the support template", async () => {
    const templates = await readProjectTemplates();
    expect(templates).toHaveLength(1);
    for (const template of templates) {
      mocks.create.mockClear();
      mocks.findUnique.mockResolvedValue({ ...template, createdById: "seed-user" });
      const response = await POST(request(), { params: Promise.resolve({ id: template.id }) });
      expect(response.status).toBe(201);
      expect(mocks.findUnique).toHaveBeenLastCalledWith({ where: { id: template.id } });
      expect(mocks.create).toHaveBeenCalledTimes(1);
      const { data, include } = mocks.create.mock.calls[0][0];
      expect(data).toEqual({
        name: "Новая доска", ownerId: "admin", description: template.templateData.descriptionHint,
        lifecycleColumnMap: { contractVersion: 1,
          submittedColumnId: data.columns.create[0].id, inProgressColumnId: data.columns.create[1].id,
          needsInfoColumnId: data.columns.create[2].id, completedColumnId: data.columns.create[3].id,
          closedColumnId: data.columns.create[4].id },
        columns: { create: template.templateData.columns.map(column => ({
          id: expect.any(String), name: column.name, color: column.color, position: column.position,
          workflowKey: column.workflowKey === "CUSTOM" ? expect.stringMatching(/^COLUMN_/) : column.workflowKey,
        })) },
        tags: { create: [] },
      });
      const columns = data.columns.create;
      expect(new Set(columns.map((column: { workflowKey: string }) => column.workflowKey)).size).toBe(template.templateData.columns.length);
      template.templateData.columns.forEach((column, index) => {
        if (column.workflowKey === "CUSTOM") {
          expect(columns[index].workflowKey).toBe(`COLUMN_${columns[index].id}`);
        }
        if (column.final) expect(columns[index].workflowKey).toBe("DONE");
      });
      expect(include).toEqual({ columns: { orderBy: { position: "asc" } }, tags: true });
    }
  });

  it.each([undefined, null, ""])("uses the hint for an empty description %j", async description => {
    const [template] = await readProjectTemplates();
    mocks.findUnique.mockResolvedValue({ ...template, createdById: "seed-user" });
    expect((await POST(request(description), { params: Promise.resolve({ id: template.id }) })).status).toBe(201);
    expect(mocks.create.mock.calls[0][0].data.description).toBe(template.templateData.descriptionHint);
  });

  it("preserves an explicit project description", async () => {
    const [template] = await readProjectTemplates();
    mocks.findUnique.mockResolvedValue({ ...template, createdById: "seed-user" });
    expect((await POST(request("Описание администратора"), { params: Promise.resolve({ id: template.id }) })).status).toBe(201);
    expect(mocks.create.mock.calls[0][0].data.description).toBe("Описание администратора");
  });

  it("keeps board creation restricted to a global administrator", async () => {
    mocks.requireApiUser.mockResolvedValue({ id: "user", globalRole: "USER" });
    expect((await POST(request(), { params: Promise.resolve({ id: "builtin" }) })).status).toBe(403);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
