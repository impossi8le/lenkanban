import { describe, expect, it } from "vitest";
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_TRIGGERS,
  isAutomationTrigger,
  parseAutomationActions,
} from "./automation-actions";

describe("notification-only automation action contract", () => {
  it("exposes the five executable action types", () => {
    expect([...AUTOMATION_ACTION_TYPES]).toEqual(["notify_assignees", "notify_creator", "move_to_column", "change_priority", "assign_user"]);
  });
  it.each([
    { type: "move_to_column", params: { columnId: "column-2" } },
    ...["LOW", "MEDIUM", "HIGH", "URGENT", "CRITICAL"].map(priority => ({ type: "change_priority", params: { priority } })),
    { type: "assign_user", params: { userId: "user-2" } },
  ])("accepts exact mutation params $type", action => {
    expect(parseAutomationActions([action])).toEqual([action]);
    expect(parseAutomationActions([{ ...action, params: { ...action.params, extra: "denied" } }])).toBeNull();
  });
  it.each([
    { type: "move_to_column", params: { columnId: "" } },
    { type: "assign_user", params: { userId: 1 } },
    { type: "change_priority", params: { priority: "high" } },
  ])("rejects invalid mutation params $type", action => {
    expect(parseAutomationActions([action])).toBeNull();
  });
  it("accepts closed optional text params and returns independent snapshots", () => {
    const input = Object.freeze([Object.freeze({ type: "notify_assignees", params: Object.freeze({ title: "synthetic-title", message: "synthetic-message" }) }), Object.freeze({ type: "notify_creator", params: Object.freeze({}) })]);
    const result = parseAutomationActions(input);
    expect(result).toEqual(input); expect(result).not.toBe(input); expect(result?.[0].params).not.toBe(input[0].params);
  });
  it.each([undefined, null, [], {}, [{ type: "notify_assignees" }], [{ type: "notify_creator", params: null }], [{ type: "notify_creator", params: { title: 3 } }], [{ type: "notify_assignees", params: { message: "secret", userId: "other" } }], [{ type: "notify_creator", params: {}, target: "other" }]].map(value => ({ value })))("rejects malformed actions %# as a whole", ({ value }) => {
    expect(parseAutomationActions(value)).toBeNull();
  });
  it.each(["add_tag", "remove_tag", "change_priority", "assign_user", "move_to_column", "add_comment", "unknown"])("rejects mixed %s without executing supported prefix", type => {
    expect(parseAutomationActions([{ type: "notify_assignees", params: {} }, { type, params: {} }])).toBeNull();
  });
});

describe("closed automation trigger catalog", () => {
  it("exposes only events emitted by the shared mutation paths", () => {
    expect([...AUTOMATION_TRIGGERS]).toEqual([
      "task_created", "status_changed", "priority_changed", "assignee_added", "deadline_set", "tag_added",
    ]);
    expect(AUTOMATION_TRIGGERS).toContain("status_changed");
  });
  it.each(AUTOMATION_TRIGGERS.map(trigger => ({ trigger })))("accepts %s", ({ trigger }) => {
    expect(isAutomationTrigger(trigger)).toBe(true);
  });
  it.each([undefined, null, "", "custom", "status", "Status_Changed", 0, {}, ["status_changed"]].map(value => ({ value })))("rejects %# as a trigger", ({ value }) => {
    expect(isAutomationTrigger(value)).toBe(false);
  });
});
