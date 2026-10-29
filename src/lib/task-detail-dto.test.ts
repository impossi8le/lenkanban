import { describe, expect, it } from "vitest";
import { taskDetailInclude, toDescriptionEditedAt, toTaskDetailDTO } from "./task-detail-dto";

describe("task detail payload", () => {
  it("still selects checklist item rows for the opened card", () => {
    expect(taskDetailInclude).toHaveProperty("checklistItems");
    expect(taskDetailInclude).toHaveProperty("tags");
    expect(taskDetailInclude).toHaveProperty("assignees");
    expect(taskDetailInclude.createdBy.select.primaryDepartment.select.name).toBe(true);
    expect(taskDetailInclude.request.select).toEqual({ state: true, executorId: true, audienceUserIds: true, beznalPhase: true,
      author: { select: { id: true, name: true } }, executor: { select: { id: true, name: true } } });
  });

  it("maps checklist item rows into the card DTO", () => {
    const createdAt = new Date("2026-09-01T12:00:00Z");
    const updatedAt = new Date("2026-09-02T12:00:00Z");
    const dto = toTaskDetailDTO({
      id: "task-1",
      title: "Synthetic",
      description: null,
      status: "TODO",
      priority: "MEDIUM",
      position: 1024,
      rank: "0000000000000000001",
      version: 3,
      projectId: "project-1",
      columnId: "column-1",
      createdById: "user-1",
      createdBy: { id: "user-1", name: "Ольга", primaryDepartment: { name: "Колл-центр" } },
      request: { state: "NEEDS_INFO", executorId: "specialist-1", audienceUserIds: ["specialist-1"],
        author: { id: "user-1", name: "Ольга" }, executor: { id: "specialist-1", name: "Специалист" } },
      column: { id: "column-1", name: "Ждём сотрудника", color: "#f0ad00" },
      project: { id: "project-1", name: "Техподдержка и ИТ" },
      importKey: null,
      deadline: null,
      createdAt,
      updatedAt,
      activities: [{ createdAt }],
      attachments: [],
      assignees: [],
      tags: [],
      checklistItems: [
        { id: "check-1", taskId: "task-1", text: "Check", completed: true, position: 0, createdAt, updatedAt },
      ],
    });

    expect(dto.checklistItems).toHaveLength(1);
    expect(dto.descriptionEditedAt).toBe(createdAt.toISOString());
    expect(dto.descriptionEditedAt).not.toBe(dto.updatedAt);
    expect(dto).not.toHaveProperty("activities");
    expect(dto.createdBy).toEqual({ id: "user-1", name: "Ольга", primaryDepartment: { name: "Колл-центр" } });
    expect(dto.request).toEqual({ state: "NEEDS_INFO", executorId: "specialist-1", beznalPhase: null, isPersonal: true,
      author: { id: "user-1", name: "Ольга" }, executor: { id: "specialist-1", name: "Специалист" } });
    expect(dto.request).not.toHaveProperty("audienceUserIds");
    expect(dto.project?.name).toBe("Техподдержка и ИТ");
    expect(dto.checklistItems?.[0]).toMatchObject({
      id: "check-1",
      completed: true,
      createdAt: createdAt.toISOString(),
    });
  });
});


describe("actor-aware task attachment projection", () => {
  const base = {
    id: "task-1", title: "Synthetic", description: null, status: "TODO", priority: "MEDIUM",
    position: 1024, rank: "0000000000000000001", version: 1, projectId: "project-1",
    columnId: "column-1", createdById: "user-1", importKey: null, deadline: null,
    createdAt: new Date("2026-09-01T12:00:00Z"), updatedAt: new Date("2026-09-01T12:00:00Z"),
    assignees: [], tags: [], checklistItems: [], activities: [],
  };
  const publicFile = { url: "/api/tasks/task-1/files/00000000-0000-4000-8000-000000000001", name: "public.txt", size: 6, mime: "text/plain" };
  const internalFile = {
    ...publicFile,
    url: "/api/tasks/task-1/files/00000000-0000-4000-8000-000000000002",
    name: "internal.txt",
    isInternal: true,
  };

  it("fails closed when a caller forgets the shared ACL projection", () => {
    const dto = toTaskDetailDTO({ ...base, attachments: [publicFile, internalFile] });
    expect(dto.attachments).toEqual([publicFile]);
    expect(JSON.stringify(dto)).not.toContain("internal.txt");
    expect(JSON.stringify(dto)).not.toContain("isInternal");
  });

  it("keeps duplicate public metadata from exposing an inherited internal URL", () => {
    const dto = toTaskDetailDTO({
      ...base,
      attachments: [publicFile, internalFile, { ...publicFile, url: internalFile.url, name: "duplicate-public.txt" }],
    });
    expect(dto.attachments).toEqual([publicFile]);
  });

  it("presents the fresh authorized internal projection without the server flag", () => {
    const dto = toTaskDetailDTO({ ...base, attachments: [publicFile, internalFile] }, [publicFile, internalFile]);
    const internalDto = { url: internalFile.url, name: internalFile.name, size: internalFile.size, mime: internalFile.mime };
    expect(dto.attachments).toEqual([publicFile, internalDto]);
    expect(dto.attachments?.[1]).not.toHaveProperty("isInternal");
  });

  it("presents a revoked internal reader's empty projection even if raw metadata remains", () => {
    const dto = toTaskDetailDTO({ ...base, attachments: [publicFile, internalFile] }, [publicFile]);
    expect(dto.attachments).toEqual([publicFile]);
  });
});

it("selects only the last proven post-submission description edit timestamp", () => {
  expect(taskDetailInclude.activities).toEqual({
    where: { action: "description_changed", newValue: { path: ["afterSubmission"], equals: true } },
    select: { createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1,
  });
});
it.each([undefined, [], [{ createdAt: new Date("invalid") }]])("does not infer a description edit from missing or invalid history %j", activities => {
  expect(toDescriptionEditedAt(activities)).toBeNull();
});
