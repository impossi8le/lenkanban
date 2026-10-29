import { describe, expect, it } from "vitest";

import {
  canReadInternalDiscussion,
  normalizeCommentVisibility,
  resolveCommentRecipients,
  resolveQueueRecipients,
} from "./discussion-policy";

describe("internal discussion access", () => {
  const base = {
    globalRole: "USER" as const,
    activeGroupMember: false,
    activeDepartmentLeader: false,
    scopedInternalGrant: false,
  };

  it.each([
    ["global administrator", { globalRole: "ADMIN" as const }, true],
    ["responsible group member", { activeGroupMember: true }, true],
    ["configured department leader", { activeDepartmentLeader: true }, true],
    ["scoped department/board administrator", { scopedInternalGrant: true }, true],
    ["author or watcher without an internal role", {}, false],
    ["ordinary user", {}, false],
  ])("allows %s only through an explicit internal role", (_label, overrides, expected) => {
    expect(canReadInternalDiscussion({ ...base, ...overrides })).toBe(expected);
  });

  it("does not derive internal access from the ordinary author/watcher facts", () => {
    // The policy input has no author/watcher fields at all: a caller cannot
    // smuggle them into the decision.
    expect(Object.keys(base).sort()).toEqual([
      "activeDepartmentLeader", "activeGroupMember", "globalRole", "scopedInternalGrant",
    ]);
  });
});

describe("comment notification recipients", () => {
  const internalReaders = new Set(["author", "executor", "leader", "watcher"]);

  it("notifies author, executor, watchers and configured leadership once each", () => {
    const recipients = resolveCommentRecipients({
      actorId: "commenter",
      visibility: "PUBLIC",
      authorId: "author",
      executorId: "executor",
      watcherIds: ["watcher", "author"],
      managementIds: ["leader", "executor"],
      internalReaderIds: internalReaders,
    });
    expect(recipients).toEqual(["author", "executor", "leader", "watcher"]);
  });

  it("never notifies the actor and never expands the responsible group", () => {
    const recipients = resolveCommentRecipients({
      actorId: "author",
      visibility: "PUBLIC",
      authorId: "author",
      executorId: "executor",
      watcherIds: [],
      managementIds: ["leader"],
    });
    expect(recipients).toEqual(["executor", "leader"]);
    // Group members are not an input to a per-comment notification.
    expect(recipients).not.toContain("group-member");
  });

  it("filters internal recipients to users who may read the internal part", () => {
    const recipients = resolveCommentRecipients({
      actorId: "commenter",
      visibility: "INTERNAL",
      authorId: "author",
      executorId: "executor",
      watcherIds: ["watcher", "outside-watcher"],
      managementIds: ["leader", "outside-leader"],
      internalReaderIds: internalReaders,
    });
    expect(recipients).toEqual(["author", "executor", "leader", "watcher"]);
  });

  it("delivers no internal notification when the reader set is unknown", () => {
    expect(resolveCommentRecipients({
      actorId: "commenter",
      visibility: "INTERNAL",
      authorId: "author",
      executorId: "executor",
      watcherIds: ["watcher"],
      managementIds: ["leader"],
    })).toEqual([]);
  });

  it("uses legacy assignees only when there is no request executor", () => {
    const common = {
      actorId: "commenter",
      visibility: "PUBLIC" as const,
      authorId: null,
      executorId: null,
      watcherIds: [],
      managementIds: [],
    };
    expect(resolveCommentRecipients({ ...common, assigneeIds: ["assignee", "assignee"] }))
      .toEqual(["assignee"]);
  });
});

describe("queue notification recipients", () => {
  it("notifies the whole responsible group and leadership without duplicates or the actor", () => {
    expect(resolveQueueRecipients({
      actorId: "author",
      groupMemberIds: ["member-a", "member-b", "member-a"],
      managementIds: ["leader", "member-b"],
    })).toEqual(["leader", "member-a", "member-b"]);
  });
});

describe("server-side comment type", () => {
  it.each([
    [undefined, undefined, "PUBLIC"],
    ["PUBLIC", undefined, "PUBLIC"],
    ["INTERNAL", undefined, "INTERNAL"],
    [undefined, true, "INTERNAL"],
    [undefined, false, "PUBLIC"],
    ["INTERNAL", true, "INTERNAL"],
    ["PUBLIC", false, "PUBLIC"],
  ] as const)("normalizes (%s, %s) to %s", (value, legacy, expected) => {
    expect(normalizeCommentVisibility(value, legacy)).toBe(expected);
  });

  it.each([
    ["UNKNOWN", undefined],
    ["", undefined],
    ["INTERNAL", false],
    ["PUBLIC", true],
    [undefined, "true"],
    [42, undefined],
  ])("rejects invalid or conflicting input (%s, %s)", (value, legacy) => {
    expect(normalizeCommentVisibility(value, legacy)).toBeNull();
  });
});
