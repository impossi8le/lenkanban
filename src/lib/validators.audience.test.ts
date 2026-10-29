import { describe, expect, it } from "vitest";
import { createTaskSchema } from "./validators";
const legacy = { title: "Помощь", projectId: "project" };
const structured = { ...legacy, requestDetails: { kind: "it", category: "Звук" } };
describe("explicit request audience input", () => {
  it("requires an explicit audience on structured forms but preserves old unstructured creators", () => {
    expect(createTaskSchema.safeParse(structured).success).toBe(false);
    expect(createTaskSchema.safeParse(legacy).success).toBe(true);
    expect(createTaskSchema.safeParse({ ...structured, audience: { mode: "DEPARTMENT", userIds: [] } }).success).toBe(true);
    expect(createTaskSchema.safeParse({ ...legacy, audience: { mode: "SELECTED", userIds: ["recipient"] } }).success).toBe(true);
  });
  it.each([{ mode: "SELECTED", userIds: [] }, { mode: "SELECTED", userIds: ["same", "same"] }, { mode: "SELECTED", userIds: Array.from({length:21},(_,i)=>`user-${i}`) }, { mode: "SELECTED", userIds: ["bad id"] }, { mode: "DEPARTMENT", userIds: ["user"] }, { mode: "SELECTED", userIds: ["user"], extra: true }])("rejects malformed or ambiguous audience %j", audience => {
    expect(createTaskSchema.safeParse({ ...structured, audience }).success).toBe(false);
  });
});
