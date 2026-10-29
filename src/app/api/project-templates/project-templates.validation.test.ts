import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  loggerError: vi.fn(),
  rateLimit: vi.fn(),
  project: { findFirst: vi.fn(), create: vi.fn() },
  projectTemplate: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: { project: mocks.project, projectTemplate: mocks.projectTemplate } }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: mocks.loggerError } }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(), rateLimitOrThrowKey: mocks.rateLimit,
}));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.requireApiUser,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { UnauthorizedError } from "@/lib/require-api-user";
import { GET as listTemplates, POST as saveTemplate } from "./route";
import { POST as applyTemplate } from "./[id]/use/route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/project-templates", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

const params = () => ({ params: Promise.resolve({ id: "template-1" }) });
function noWrites() {
  expect(mocks.project.create).not.toHaveBeenCalled();
  expect(mocks.projectTemplate.create).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.requireApiUser.mockResolvedValue({ id: "creator-1", globalRole: "USER" });
  mocks.project.findFirst.mockResolvedValue({ id: "project-1", columns: [], tags: [] });
  mocks.projectTemplate.findUnique.mockResolvedValue({
    id: "template-1", createdById: "creator-1", templateData: { columns: [], tags: [] },
  });
  mocks.projectTemplate.create.mockResolvedValue({ id: "template-new" });
  mocks.project.create.mockResolvedValue({ id: "project-new" });
});

const endpoints = [
  { name: "save", call: (input: Request) => saveTemplate(input), valid: { name: "Template", projectId: "project-1" } },
  { name: "use", call: (input: Request) => applyTemplate(input, params()), valid: { projectName: "Project" } },
];

describe.each(endpoints)("project template $name POST envelope", ({ name, call, valid }) => {
  beforeEach(() => {
    if (name === "use") mocks.requireApiUser.mockResolvedValue({ id: "creator-1", globalRole: "ADMIN" });
  });
  it.each([null, [], ["entry"], "primitive", 42, true].map((body, index) => ({ body, index })))("rejects a non-object body case $index before writes", async ({ body }) => {
    const response = await call(request(body));
    expect(response.status).toBe(400);
    noWrites();
  });

  it("keeps malformed JSON as 400", async () => {
    const response = await call(new Request("http://localhost/api/project-templates", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
    noWrites();
  });

  it("keeps unauthenticated calls as 401 without database access", async () => {
    mocks.requireApiUser.mockRejectedValue(new UnauthorizedError());
    const response = await call(request(valid));
    expect(response.status).toBe(401);
    expect(mocks.project.findFirst).not.toHaveBeenCalled();
    expect(mocks.projectTemplate.findUnique).not.toHaveBeenCalled();
    noWrites();
  });
});

describe("saving a project template validates metadata", () => {
  it.each([{}, { projectId: "project-1" }, { name: "Template" }])("rejects missing required metadata %j", async (body) => {
    expect((await saveTemplate(request(body))).status).toBe(400);
    noWrites();
  });

  it.each([null, [], {}, 42, true, "", "   "].map((projectId, index) => ({ projectId, index })))("rejects invalid source project id case $index", async ({ projectId }) => {
    expect((await saveTemplate(request({ name: "Template", projectId }))).status).toBe(400);
    noWrites();
  });

  it.each(["", "   ", 4, null, "x".repeat(121)].map((name, index) => ({ name, index })))("rejects invalid name case $index", async ({ name }) => {
    expect((await saveTemplate(request({ name, projectId: "project-1" }))).status).toBe(400);
    noWrites();
  });

  it.each([42, {}, [], true, "x".repeat(10_001)].map((description, index) => ({ description, index })))("rejects invalid description case $index", async ({ description }) => {
    expect((await saveTemplate(request({ name: "Template", projectId: "project-1", description }))).status).toBe(400);
    noWrites();
  });

  it("trims accepted metadata and snapshots only columns and tags", async () => {
    mocks.project.findFirst.mockResolvedValue({
      id: "project-1", columns: [{ name: "New", color: "#fff", position: 0, workflowKey: "TODO" }],
      tags: [{ name: "Tag", color: "#000" }], members: [{ userId: "foreign" }],
    });
    const response = await saveTemplate(request({ name: "  Template  ", description: "  Helpful  ", projectId: "project-1", createdById: "foreign" }));
    expect(response.status).toBe(201);
    expect(mocks.projectTemplate.create.mock.calls[0][0].data).toEqual({
      name: "Template", description: "Helpful", createdById: "creator-1",
      templateData: {
        columns: [{ name: "New", color: "#fff", position: 0, workflowKey: "TODO" }],
        tags: [{ name: "Tag", color: "#000" }],
        availability: "creator",
      },
    });
  });

  it.each([null, undefined])("supports optional nullable description %j", async (description) => {
    expect((await saveTemplate(request({ name: "x".repeat(120), projectId: "project-1", description }))).status).toBe(201);
    expect(mocks.projectTemplate.create.mock.calls[0][0].data.description ?? null).toBeNull();
  });

  it("accepts exact maximum name and description lengths", async () => {
    const name = "x".repeat(120), description = "x".repeat(10_000);
    expect((await saveTemplate(request({ name, description, projectId: "project-1" }))).status).toBe(201);
    expect(mocks.projectTemplate.create.mock.calls[0][0].data).toMatchObject({ name, description });
  });

  it("denies an outsider without saving", async () => {
    mocks.project.findFirst.mockResolvedValue(null);
    expect((await saveTemplate(request({ name: "Template", projectId: "project-1" }))).status).toBe(403);
    noWrites();
  });

  it("returns 404 for an administrator's missing source project", async () => {
    mocks.requireApiUser.mockResolvedValue({ id: "admin-1", globalRole: "ADMIN" });
    mocks.project.findFirst.mockResolvedValue(null);
    expect((await saveTemplate(request({ name: "Template", projectId: "missing" }))).status).toBe(404);
    noWrites();
  });
});

describe("using a project template validates project metadata", () => {
  beforeEach(() => mocks.requireApiUser.mockResolvedValue({ id: "creator-1", globalRole: "ADMIN" }));
  it("rejects an object with missing projectName", async () => {
    expect((await applyTemplate(request({}), params())).status).toBe(400);
    noWrites();
  });

  it.each(["", "   ", null, 7, "x".repeat(121)].map((projectName, index) => ({ projectName, index })))("rejects invalid project name case $index", async ({ projectName }) => {
    expect((await applyTemplate(request({ projectName }), params())).status).toBe(400);
    noWrites();
  });

  it.each([42, {}, [], true, "x".repeat(10_001)].map((projectDescription, index) => ({ projectDescription, index })))("rejects invalid project description case $index", async ({ projectDescription }) => {
    expect((await applyTemplate(request({ projectName: "Project", projectDescription }), params())).status).toBe(400);
    noWrites();
  });

  it("trims both metadata fields using project creation limits", async () => {
    expect((await applyTemplate(request({ projectName: "  Project  ", projectDescription: "  Details  " }), params())).status).toBe(201);
    expect(mocks.project.create.mock.calls[0][0].data).toMatchObject({ name: "Project", description: "Details", ownerId: "creator-1" });
  });

  it.each([null, undefined])("allows nullable or omitted description %j", async (projectDescription) => {
    expect((await applyTemplate(request({ projectName: "x".repeat(120), projectDescription }), params())).status).toBe(201);
    expect(mocks.project.create.mock.calls[0][0].data.description ?? null).toBeNull();
  });

  it("accepts an exact 10000 character description", async () => {
    const projectDescription = "x".repeat(10_000);
    expect((await applyTemplate(request({ projectName: "Project", projectDescription }), params())).status).toBe(201);
    expect(mocks.project.create.mock.calls[0][0].data.description).toBe(projectDescription);
  });

  it("returns 404 for a missing template", async () => {
    mocks.projectTemplate.findUnique.mockResolvedValue(null);
    expect((await applyTemplate(request({ projectName: "Project" }), params())).status).toBe(404);
    noWrites();
  });

  it("denies another creator's template", async () => {
    mocks.requireApiUser.mockResolvedValue({ id: "creator-1", globalRole: "USER" });
    mocks.projectTemplate.findUnique.mockResolvedValue({ createdById: "foreign", templateData: {} });
    expect((await applyTemplate(request({ projectName: "Project" }), params())).status).toBe(403);
    noWrites();
  });

  it("preserves administrator use of another creator's organization-shared template", async () => {
    mocks.requireApiUser.mockResolvedValue({ id: "admin-1", globalRole: "ADMIN" });
    mocks.projectTemplate.findUnique.mockResolvedValue({
      createdById: "foreign",
      templateData: { availability: "organization" },
    });
    expect((await applyTemplate(request({ projectName: "Project" }), params())).status).toBe(201);
    expect(mocks.project.create.mock.calls[0][0].data.ownerId).toBe("admin-1");
  });
});

const invalidStoredData = [
  null, [], "stored-private-sentinel", 42,
  { columns: {} }, { columns: "stored-private-sentinel" }, { tags: {} }, { tags: "stored-private-sentinel" },
  { columns: [null] }, { columns: [{}] }, { columns: [{ name: 7, color: "#fff", position: 0 }] },
  { columns: [{ name: "New", color: false, position: 0 }] },
  { columns: [{ name: "New", color: "#fff", position: 1.5 }] },
  { columns: [{ name: "New", color: "#fff", position: "0" }] },
  { columns: [{ name: "New", color: "#fff", position: 2147483648 }] },
  { columns: [{ name: "New", color: "#fff", position: -2147483649 }] },
  { columns: [{ name: "One", color: "#fff", position: 0 }, { name: "Two", color: "#fff", position: 0 }] },
  { columns: [{ name: "One", color: "#fff", position: 0, workflowKey: "TODO" }, { name: "Two", color: "#fff", position: 1, workflowKey: "TODO" }] },
  { columns: [{ name: "TODO", color: "#fff", position: 0 }, { name: "TODO", color: "#fff", position: 1 }] },
  { tags: [null] }, { tags: [{}] }, { tags: [{ name: 7, color: "#fff" }] }, { tags: [{ name: "Tag", color: false }] },
  { tags: [{ name: "Tag", color: "#fff" }, { name: "Tag", color: "#000" }] },
];

describe("stored template data is validated before nested project creation", () => {
  beforeEach(() => mocks.requireApiUser.mockResolvedValue({ id: "creator-1", globalRole: "ADMIN" }));
  it.each(invalidStoredData.map((value, index) => ({ value, index })))("rejects malformed stored data case $index with a fixed safe response", async ({ value }) => {
    mocks.projectTemplate.findUnique.mockResolvedValue({ createdById: "creator-1", templateData: value });
    const response = await applyTemplate(request({ projectName: "Project" }), params());
    expect(response.status).toBe(400);
    const payload = await response.text();
    expect(payload).not.toContain("stored-private-sentinel");
    noWrites();
    mocks.projectTemplate.findUnique.mockResolvedValue({ createdById: "creator-1", templateData: null });
    const sameFailure = await applyTemplate(request({ projectName: "Project" }), params());
    expect(sameFailure.status).toBe(400);
    expect(await sameFailure.text()).toBe(payload);
    noWrites();
  });

  it.each([{}, { columns: [], tags: [] }])("supports absent or empty optional arrays %j", async (templateData) => {
    mocks.projectTemplate.findUnique.mockResolvedValue({ createdById: "creator-1", templateData });
    expect((await applyTemplate(request({ projectName: "Project" }), params())).status).toBe(201);
    expect(mocks.project.create.mock.calls[0][0].data).toEqual({
      name: "Project", description: null, ownerId: "creator-1", columns: { create: [] }, tags: { create: [] },
    });
  });

  it("creates only allowed nested data and preserves known workflow keys", async () => {
    mocks.projectTemplate.findUnique.mockResolvedValue({
      createdById: "creator-1", templateData: {
        columns: [{ name: "Review", color: "#fff", position: -2, workflowKey: "REVIEW", members: [{ userId: "foreign" }] }],
        tags: [{ name: "Tag", color: "#000", projectId: "foreign" }],
        ownerId: "foreign", members: [{ userId: "foreign", role: "OWNER" }], tasks: [{ title: "Hidden" }], visibility: "PUBLIC",
      },
    });
    const response = await applyTemplate(request({ projectName: "Project", ownerId: "foreign", members: ["foreign"], tasks: ["Hidden"], visibility: "PUBLIC" }), params());
    expect(response.status).toBe(201);
    expect(mocks.project.create).toHaveBeenCalledTimes(1);
    expect(mocks.project.create.mock.calls[0][0]).toEqual({
      data: {
        name: "Project", description: null, ownerId: "creator-1",
        columns: { create: [{ id: expect.any(String), name: "Review", color: "#fff", position: -2, workflowKey: "REVIEW" }] },
        tags: { create: [{ name: "Tag", color: "#000" }] },
      },
      include: { columns: { orderBy: { position: "asc" } }, tags: true },
    });
  });

  it("remaps repeated custom keys to distinct column keys", async () => {
    mocks.projectTemplate.findUnique.mockResolvedValue({ createdById: "creator-1", templateData: { columns: [
      { name: "Custom one", color: "#fff", position: 0, workflowKey: "COLUMN_old" },
      { name: "Custom two", color: "#000", position: 1, workflowKey: "COLUMN_old" },
    ] } });
    expect((await applyTemplate(request({ projectName: "Project" }), params())).status).toBe(201);
    const columns = mocks.project.create.mock.calls[0][0].data.columns.create;
    expect(columns).toHaveLength(2);
    expect(columns[0].workflowKey).toBe(`COLUMN_${columns[0].id}`);
    expect(columns[1].workflowKey).toBe(`COLUMN_${columns[1].id}`);
    expect(columns[0].workflowKey).not.toBe(columns[1].workflowKey);
  });

  it("preserves case-sensitive distinct tag names", async () => {
    const tags = [{ name: "Tag", color: "#fff" }, { name: "tag", color: "#000" }];
    mocks.projectTemplate.findUnique.mockResolvedValue({ createdById: "creator-1", templateData: { tags } });
    expect((await applyTemplate(request({ projectName: "Project" }), params())).status).toBe(201);
    expect(mocks.project.create.mock.calls[0][0].data.tags).toEqual({ create: tags });
  });
});

const failingOperations = [
  {
    name: "save", failure: mocks.projectTemplate.create,
    call: () => saveTemplate(request({ name: "Template", projectId: "project-1", description: "synthetic-private-sentinel" })),
    event: "project.template.create.failed", route: "/api/project-templates",
  },
  {
    name: "apply", failure: mocks.project.create,
    call: () => applyTemplate(request({ projectName: "Project", projectDescription: "synthetic-private-sentinel" }), params()),
    event: "project.template.use.failed", route: "/api/project-templates/:id/use",
  },
  {
    name: "list", failure: mocks.projectTemplate.findMany,
    call: () => listTemplates(new Request("http://localhost/api/project-templates")),
    event: "project.template.list.failed", route: "/api/project-templates",
  },
];

describe.each(failingOperations)("project template $name failure diagnostics", ({ name, failure, call, event, route }) => {
  beforeEach(() => {
    if (name === "apply") mocks.requireApiUser.mockResolvedValue({ id: "creator-1", globalRole: "ADMIN" });
  });
  function privateFailure() {
    return new Error("synthetic-private-sentinel", {
      cause: { token: "synthetic-private-sentinel", nested: { body: "synthetic-private-sentinel" } },
    });
  }

  it("returns a fixed 500 and logs only event and route", async () => {
    failure.mockRejectedValue(privateFailure());
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("synthetic-private-sentinel");
    expect(mocks.loggerError.mock.calls).toEqual([[{ event, route }]]);
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain("synthetic-private-sentinel");
  });

  it("keeps the same safe 500 when the logger itself throws", async () => {
    failure.mockRejectedValue(privateFailure());
    const baseline = await call();
    expect(baseline.status).toBe(500);
    const fixedPayload = await baseline.text();
    mocks.loggerError.mockClear();
    mocks.loggerError.mockImplementation(() => { throw privateFailure(); });
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(fixedPayload);
    expect(fixedPayload).not.toContain("synthetic-private-sentinel");
    expect(mocks.loggerError.mock.calls).toEqual([[{ event, route }]]);
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain("synthetic-private-sentinel");
  });
});
