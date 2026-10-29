import { describe, expect, it } from "vitest";
import { canReadTaskAudience, isTaskAudienceRecipient, taskAudienceReadPredicate, taskWatcherReadPredicate } from "./task-audience";
import { taskReadPredicate } from "./access-policy";

const actor = { id: "reader", globalRole: "USER" as const };
const selected = { authorId: "author", audienceUserIds: ["recipient"] };

describe("immutable task audience", () => {
  it("accepts a fresh persisted watcher independently of audience or destination leadership", () => {
    expect(canReadTaskAudience(actor, selected, false, true)).toBe(true);
    expect(canReadTaskAudience(actor, selected, false, false)).toBe(false);
    expect(isTaskAudienceRecipient(selected, actor.id)).toBe(false);
    expect(taskAudienceReadPredicate(actor).OR).toContainEqual(taskWatcherReadPredicate(actor));
    expect(canReadTaskAudience(actor, { ...selected, audienceUserIds: null } as never, false, true)).toBe(false);
  });
  it("preserves the legacy/general mode and explicit global ADMIN exception", () => {
    expect(canReadTaskAudience(actor, null)).toBe(true);
    expect(canReadTaskAudience(actor, { authorId: "author", audienceUserIds: [] })).toBe(true);
    expect(canReadTaskAudience({ ...actor, globalRole: "ADMIN" }, selected)).toBe(true);
    expect(taskAudienceReadPredicate({ ...actor, globalRole: "ADMIN" })).toEqual({});
  });
  it("allows only the author and chosen recipients for selected requests", () => {
    expect(canReadTaskAudience(actor, selected)).toBe(false);
    expect(canReadTaskAudience({ ...actor, id: "author" }, selected)).toBe(true);
    expect(canReadTaskAudience({ ...actor, id: "recipient" }, selected)).toBe(true);
    expect(isTaskAudienceRecipient(selected, "author")).toBe(false);
    expect(isTaskAudienceRecipient(selected, "recipient")).toBe(true);
  });
  it("permits an explicitly fresh responsible-group leader to read without granting recipient status", () => {
    expect(canReadTaskAudience(actor, selected, true)).toBe(true);
    expect(canReadTaskAudience(actor, selected, false)).toBe(false);
    expect(isTaskAudienceRecipient(selected, actor.id)).toBe(false);
    expect(taskAudienceReadPredicate(actor).OR).toContainEqual({ project: { responsibleGroup: { is: {
      archivedAt: null, leaderId: actor.id, members: { some: { userId: actor.id } },
    } } } });
    expect(canReadTaskAudience(actor, { ...selected, audienceUserIds: null } as never, true)).toBe(false);
  });
  it.each([undefined, { authorId: "author" }, { ...selected, audienceUserIds: null }, { ...selected, audienceUserIds: ["recipient", "recipient"] }, { ...selected, audienceUserIds: ["bad/id"] }])("fails closed on malformed persistence %#", row => {
    expect(canReadTaskAudience(actor, row as never)).toBe(false);
    expect(isTaskAudienceRecipient(row as never, "recipient")).toBe(false);
  });
  it.each([false, true])("caps all ordinary read grants including scoped grants (mandatoryOwn=%s)", mandatoryOwn => {
    const where = taskReadPredicate(actor, ["board"], [{}], mandatoryOwn);
    expect(where.AND).toEqual([expect.any(Object), taskAudienceReadPredicate(actor)]);
    expect(taskReadPredicate({ ...actor, globalRole: "ADMIN" }, ["board"], [{}], mandatoryOwn)).toEqual({});
  });
});
