import { describe, expect, it } from "vitest";
import type { TaskRequestState } from "./task-request-policy";
import {
  decodeStoredTaskRequest,
  planTaskRequestContentMutation,
  planTaskRequestTransition,
  taskRequestLifecycleCommandSchema,
  type TaskRequestActorFacts,
  type TaskRequestContentDecision,
  type TaskRequestTransitionDecision,
} from "./task-request-marker-lifecycle";

describe("stored lifecycle marker timers", () => {
  const stored = {
    taskId: "task", contractVersion: 1, state: "NEEDS_INFO",
    authorId: "author", executorId: "executor",
  };

  it("decodes old projections with default timers and preserves persisted timers", () => {
    expect(decodeStoredTaskRequest(stored, "task")).toEqual({
      valid: true, marker: { ...stored, needsInfoSince: null, pausedTotalMs: 0 },
    });
    const timers = { needsInfoSince: new Date("2026-10-22T10:00:00Z"), pausedTotalMs: 3500 };
    expect(decodeStoredTaskRequest({ ...stored, ...timers }, "task")).toEqual({
      valid: true, marker: { ...stored, ...timers },
    });
  });

  it.each([
    { pausedTotalMs: -1 }, { pausedTotalMs: 1.5 }, { pausedTotalMs: Infinity },
    { pausedTotalMs: 2147483648 }, { pausedTotalMs: "1" },
    { needsInfoSince: "2026-10-22T10:00:00Z" }, { needsInfoSince: new Date(NaN) },
    { unknownField: true }, { contractVersion: 2 }, { taskId: "other" },
    { state: "COMPLETED", needsInfoSince: new Date() },
  ])("fails closed on invalid marker data %o", (fields) => {
    expect(decodeStoredTaskRequest({ ...stored, ...fields }, "task")).toEqual({ valid: false });
  });

  it("rejects getters without invoking them", () => {
    const row = Object.defineProperty({ ...stored }, "needsInfoSince", {
      get: () => { throw new Error("must not be read"); },
    });
    expect(decodeStoredTaskRequest(row, "task")).toEqual({ valid: false });
  });
});

const marker = (
  state: TaskRequestState,
  executorId: string | null = null,
  authorId = "author",
) => ({ taskId: "task", contractVersion: 1 as const, state, authorId, executorId });

const author: TaskRequestActorFacts = {
  actorId: "author",
  isAuthor: true,
  isExecutor: false,
  isLeader: false,
  canParticipate: true,
  canExecute: true,
};
const executor: TaskRequestActorFacts = {
  actorId: "executor",
  isAuthor: false,
  isExecutor: true,
  isLeader: false,
  canParticipate: true,
  canExecute: true,
};
const leader: TaskRequestActorFacts = {
  actorId: "leader",
  isAuthor: false,
  isExecutor: false,
  isLeader: true,
  canParticipate: true,
  canExecute: true,
};
const observer: TaskRequestActorFacts = {
  actorId: "observer",
  isAuthor: false,
  isExecutor: false,
  isLeader: false,
  canParticipate: true,
  canExecute: true,
};
const outsider: TaskRequestActorFacts = {
  actorId: "outsider",
  isAuthor: false,
  isExecutor: false,
  isLeader: false,
  canParticipate: false,
  canExecute: false,
};

function allowed(
  decision: TaskRequestTransitionDecision,
): Extract<TaskRequestTransitionDecision, { allowed: true }> {
  expect(decision.allowed).toBe(true);
  return decision as Extract<TaskRequestTransitionDecision, { allowed: true }>;
}

function denied(
  decision: TaskRequestTransitionDecision,
  code: string,
): void {
  expect(decision).toEqual({ allowed: false, code });
}

const command = {
  operationId: "11111111-1111-4111-8111-111111111111",
  expectedVersion: 3,
};

describe("explicit takeover", () => {
  it.each(["IN_PROGRESS", "NEEDS_INFO"] as const)("preserves %s and replaces only executor", state => {
    expect(allowed(planTaskRequestTransition(marker(state, "executor"), observer, { action: "take_over" })))
      .toMatchObject({ nextState: state, nextExecutorId: "observer", changed: true, activityAction: "request_assigned",
        activity: { oldValue: { executorId: "executor", state }, newValue: { executorId: "observer", state, takenOver: true } } });
    denied(planTaskRequestTransition(marker(state, "executor"), observer, { action: "take" }), "INVALID_TRANSITION");
  });
  it.each(["DRAFT", "SUBMITTED", "COMPLETED", "CLOSED", "CANCELLED"] as const)("refuses %s", state => {
    denied(planTaskRequestTransition(marker(state, "executor"), observer, { action: "take_over" }), "INVALID_TRANSITION");
  });
  it("denies read-only and unavailable actors and makes repeat by current executor a no-op", () => {
    denied(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), { ...observer, canExecute: false }, { action: "take_over" }), "FORBIDDEN_ROLE");
    denied(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), outsider, { action: "take_over" }), "FORBIDDEN_ROLE");
    expect(allowed(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), executor, { action: "take_over" }))).toMatchObject({ changed: false });
  });
});

describe("lifecycle command schema", () => {
  it("accepts the exact payload for each action", () => {
    for (const body of [
      { ...command, action: "submit" },
      { ...command, action: "take" },
      { ...command, action: "take_over" },
      { ...command, action: "assign", assigneeId: "member" },
      { ...command, action: "request_info" },
      {
        ...command,
        action: "answer_info",
        response: { commentId: "comment" },
      },
      {
        ...command,
        action: "answer_info",
        response: { attachmentId: "file" },
      },
      { ...command, action: "complete" },
      { ...command, action: "close" },
      { ...command, action: "reopen", reason: "  Нужно доработать  " },
      { ...command, action: "cancel" },
      { ...command, action: "delete" },
      {
        ...command,
        action: "edit_description",
        description: "  Новое описание  ",
      },
      { ...command, action: "edit_description", description: null },
    ]) {
      expect(taskRequestLifecycleCommandSchema.safeParse(body).success).toBe(true);
    }
  });

  it.each([
    { ...command, action: "assign" },
    { ...command, action: "answer_info" },
    { ...command, action: "answer_info", response: {} },
    { ...command, action: "reopen" },
    { ...command, action: "reopen", reason: "   " },
    { ...command, action: "edit_description" },
    { ...command, action: "submit", assigneeId: "member" },
    { ...command, action: "take", reason: "why" },
    { ...command, action: "complete", response: { commentId: "comment" } },
    { ...command, action: "close", reason: "not part of close" },
    { ...command, action: "close", assigneeId: "other" },
    { ...command, action: "cancel", description: "text" },
    { ...command, action: "unknown" },
    { ...command, action: "submit", projectId: "other-project" },
    { ...command, action: "submit", columnId: "other-column" },
    { ...command, action: "assign", assigneeId: "member", extra: true },
    { ...command, expectedVersion: -1, action: "submit" },
    { ...command, expectedVersion: 2147483648, action: "submit" },
    { ...command, operationId: "not-a-uuid", action: "submit" },
  ])("rejects malformed or cross-board payload %#", (body) => {
    expect(taskRequestLifecycleCommandSchema.safeParse(body).success).toBe(false);
  });

  it("bounds reason and description lengths", () => {
    expect(taskRequestLifecycleCommandSchema.safeParse({
      ...command,
      action: "reopen",
      reason: "x".repeat(2001),
    }).success).toBe(false);
    expect(taskRequestLifecycleCommandSchema.safeParse({
      ...command,
      action: "edit_description",
      description: "x".repeat(50_001),
    }).success).toBe(false);
    expect(taskRequestLifecycleCommandSchema.safeParse({
      ...command,
      action: "edit_description",
      description: "x".repeat(50_000),
    }).success).toBe(true);
  });
});

describe("lifecycle transition table", () => {
  const groupLeader = { ...observer, actorId: "group-leader", canExecute: false, isResponsibleGroupLeader: true };

  it.each([executor, groupLeader])("closes completed requests only for the executor or explicit group leader %#", actor => {
    const plan = allowed(planTaskRequestTransition(marker("COMPLETED", "executor"), actor, { action: "close" }));
    expect(plan).toMatchObject({ nextState: "CLOSED", nextExecutorId: "executor", changed: true, activityAction: "request_closed" });
    expect(plan.activity).toEqual({ oldValue: { state: "COMPLETED", executorId: "executor" }, newValue: { state: "CLOSED", executorId: "executor" } });
  });

  it.each([author, leader, observer, { ...observer, globalRole: "ADMIN" },
    { ...groupLeader, isResponsibleGroupLeader: false }, { ...executor, canExecute: false },
    { ...groupLeader, canParticipate: false }, { ...groupLeader, isResponsibleGroupLeader: "true" },
  ])("denies close without fresh specific authority %#", actor => {
    denied(planTaskRequestTransition(marker("COMPLETED", "executor"), actor as TaskRequestActorFacts, { action: "close" }), "FORBIDDEN_ROLE");
  });

  it.each(["DRAFT", "SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "CANCELLED"] as const)("does not skip %s directly to CLOSED", state => {
    denied(planTaskRequestTransition(marker(state, state === "DRAFT" || state === "SUBMITTED" ? null : "executor"), groupLeader, { action: "close" }), "INVALID_TRANSITION");
  });

  it.each([executor, groupLeader])("keeps an authorized already-closed action a no-op %#", actor => {
    expect(allowed(planTaskRequestTransition(marker("CLOSED", "executor"), actor, { action: "close" }))).toMatchObject({ nextState: "CLOSED", nextExecutorId: "executor", changed: false });
    denied(planTaskRequestTransition(marker("CLOSED", "executor"), author, { action: "close" }), "FORBIDDEN_ROLE");
    denied(planTaskRequestTransition(marker("COMPLETED"), groupLeader, { action: "close" }), "INVALID_TRANSITION");
  });

  it.each([true, false])("lets the author reopen CLOSED with a reason, executor available=%s", executorAvailable => {
    const plan = allowed(planTaskRequestTransition(marker("CLOSED", "executor"), author, {
      action: "reopen", reason: "Нужно доработать", executorAvailable,
    }));
    expect(plan).toMatchObject({ nextState: executorAvailable ? "IN_PROGRESS" : "SUBMITTED", nextExecutorId: executorAvailable ? "executor" : null, changed: true, activityAction: "request_reopened" });
    expect(plan.activity.newValue).toMatchObject({ reason: "Нужно доработать" });
  });

  it("requires author and nonempty reason for CLOSED reopening", () => {
    for (const reason of [undefined, "", "   "]) denied(planTaskRequestTransition(marker("CLOSED", "executor"), author, { action: "reopen", reason }), "REASON_REQUIRED");
    for (const actor of [executor, leader, observer, groupLeader]) denied(planTaskRequestTransition(marker("CLOSED", "executor"), actor, { action: "reopen", reason: "why" }), "FORBIDDEN_ROLE");
  });

  it.each(["submit", "take", "assign", "request_info", "answer_info", "complete", "cancel", "delete", "edit_description"] as const)("does not leave CLOSED via %s", action => {
    for (const actor of [author, executor, leader, groupLeader]) {
      expect(planTaskRequestTransition(marker("CLOSED", "executor"), actor, {
        action, assigneeId: "member", response: { commentId: "comment" }, description: "text", reason: "why",
      }).allowed).toBe(false);
    }
  });

  it("decodes closed timers and preserves completed discussion permissions", () => {
    expect(decodeStoredTaskRequest(marker("CLOSED", "executor"), "task")).toMatchObject({ valid: true, marker: { state: "CLOSED", needsInfoSince: null } });
    expect(decodeStoredTaskRequest({ ...marker("CLOSED", "executor"), needsInfoSince: new Date() }, "task")).toEqual({ valid: false });
    const facts = { actorId: "author", isAuthor: true, isExecutor: false, isWatcher: false, isGroupMember: false, isLeader: false };
    for (const kind of ["comment", "attachment"] as const) {
      expect(planTaskRequestContentMutation(marker("CLOSED", "executor"), facts, kind)).toEqual(planTaskRequestContentMutation(marker("COMPLETED", "executor"), facts, kind));
    }
  });
  it("submits only the author's draft and repeats without a second transition", () => {
    const draft = marker("DRAFT");
    const first = allowed(planTaskRequestTransition(draft, author, { action: "submit" }));
    expect(first).toMatchObject({ nextState: "SUBMITTED", nextExecutorId: null, changed: true, activityAction: "request_submitted" });
    denied(planTaskRequestTransition(draft, executor, { action: "submit" }), "FORBIDDEN_ROLE");
    const repeated = allowed(planTaskRequestTransition(marker("SUBMITTED"), author, { action: "submit" }));
    expect(repeated).toMatchObject({ nextState: "SUBMITTED", changed: false });
    denied(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), author, { action: "submit" }), "INVALID_TRANSITION");
  });

  it("lets one group member take a submitted request and keeps the first taker", () => {
    const submitted = marker("SUBMITTED");
    const taken = allowed(planTaskRequestTransition(submitted, observer, { action: "take" }));
    expect(taken).toMatchObject({ nextState: "IN_PROGRESS", nextExecutorId: "observer", changed: true, activityAction: "request_taken" });
    denied(planTaskRequestTransition(marker("IN_PROGRESS", "observer"), author, { action: "take" }), "INVALID_TRANSITION");
    const repeated = allowed(planTaskRequestTransition(marker("IN_PROGRESS", "observer"), observer, { action: "take" }));
    expect(repeated).toMatchObject({ nextState: "IN_PROGRESS", nextExecutorId: "observer", changed: false });
    denied(planTaskRequestTransition(submitted, outsider, { action: "take" }), "FORBIDDEN_ROLE");
  });

  it("lets the leader assign and the executor reassign inside the board", () => {
    const assigned = allowed(planTaskRequestTransition(marker("SUBMITTED"), leader, {
      action: "assign",
      assigneeId: "member",
    }));
    expect(assigned).toMatchObject({ nextState: "IN_PROGRESS", nextExecutorId: "member", changed: true, activityAction: "request_assigned" });
    const reassigned = allowed(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), executor, {
      action: "assign",
      assigneeId: "member",
    }));
    expect(reassigned).toMatchObject({ nextState: "IN_PROGRESS", nextExecutorId: "member", changed: true });
    denied(planTaskRequestTransition(marker("SUBMITTED"), author, { action: "assign", assigneeId: "member" }), "FORBIDDEN_ROLE");
    denied(planTaskRequestTransition(marker("SUBMITTED"), leader, { action: "assign" }), "ASSIGNEE_REQUIRED");
    const same = allowed(planTaskRequestTransition(marker("IN_PROGRESS", "member"), leader, {
      action: "assign",
      assigneeId: "member",
    }));
    expect(same.changed).toBe(false);
  });

  it("pauses with the same executor and answers only through a comment or file", () => {
    const paused = allowed(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), executor, { action: "request_info" }));
    expect(paused).toMatchObject({ nextState: "NEEDS_INFO", nextExecutorId: "executor", activityAction: "request_info_requested" });
    denied(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), author, { action: "request_info" }), "FORBIDDEN_ROLE");
    const answered = allowed(planTaskRequestTransition(marker("NEEDS_INFO", "executor"), author, {
      action: "answer_info",
      response: { commentId: "comment" },
    }));
    expect(answered).toMatchObject({ nextState: "IN_PROGRESS", nextExecutorId: "executor", activityAction: "request_info_answered" });
    expect(answered.activity.newValue).toMatchObject({ response: { commentId: "comment" } });
    denied(planTaskRequestTransition(marker("NEEDS_INFO", "executor"), author, {
      action: "answer_info",
      response: {},
    }), "RESPONSE_REQUIRED");
    denied(planTaskRequestTransition(marker("NEEDS_INFO", "executor"), executor, {
      action: "answer_info",
      response: { commentId: "comment" },
    }), "FORBIDDEN_ROLE");
    const repeated = allowed(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), author, {
      action: "answer_info",
      response: { attachmentId: "file" },
    }));
    expect(repeated.changed).toBe(false);
  });

  it("completes without acceptance and reopens with a reason to the available executor or the group", () => {
    const completed = allowed(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), executor, { action: "complete" }));
    expect(completed).toMatchObject({ nextState: "COMPLETED", nextExecutorId: "executor", activityAction: "request_completed" });
    denied(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), author, { action: "complete" }), "FORBIDDEN_ROLE");
    const reopened = allowed(planTaskRequestTransition(marker("COMPLETED", "executor"), author, {
      action: "reopen",
      reason: "Нужно доработать",
      executorAvailable: true,
    }));
    expect(reopened).toMatchObject({ nextState: "IN_PROGRESS", nextExecutorId: "executor", activityAction: "request_reopened" });
    expect(reopened.activity.newValue).toMatchObject({ reason: "Нужно доработать" });
    const toGroup = allowed(planTaskRequestTransition(marker("COMPLETED", "executor"), author, {
      action: "reopen",
      reason: "Исполнитель уволен",
      executorAvailable: false,
    }));
    expect(toGroup).toMatchObject({ nextState: "SUBMITTED", nextExecutorId: null });
    denied(planTaskRequestTransition(marker("COMPLETED", "executor"), author, { action: "reopen", reason: " " }), "REASON_REQUIRED");
    denied(planTaskRequestTransition(marker("COMPLETED", "executor"), executor, { action: "reopen", reason: "why" }), "FORBIDDEN_ROLE");
  });

  it("cancels before work by the author and after work by the executor or leader", () => {
    expect(allowed(planTaskRequestTransition(marker("DRAFT"), author, { action: "cancel" })))
      .toMatchObject({ nextState: "CANCELLED", nextExecutorId: null, activityAction: "request_cancelled" });
    expect(allowed(planTaskRequestTransition(marker("SUBMITTED"), author, { action: "cancel" })))
      .toMatchObject({ nextState: "CANCELLED", nextExecutorId: null });
    expect(allowed(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), executor, { action: "cancel" })))
      .toMatchObject({ nextState: "CANCELLED", nextExecutorId: "executor" });
    expect(allowed(planTaskRequestTransition(marker("NEEDS_INFO", "executor"), leader, { action: "cancel" })))
      .toMatchObject({ nextState: "CANCELLED", nextExecutorId: "executor" });
    denied(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), author, { action: "cancel" }), "FORBIDDEN_ROLE");
    denied(planTaskRequestTransition(marker("COMPLETED", "executor"), executor, { action: "cancel" }), "INVALID_TRANSITION");
    const repeated = allowed(planTaskRequestTransition(marker("CANCELLED", "executor"), executor, { action: "cancel" }));
    expect(repeated.changed).toBe(false);
  });

  it("distinguishes logical deletion from cancellation and keeps its audit action", () => {
    const removed = allowed(planTaskRequestTransition(marker("DRAFT"), author, { action: "delete" }));
    expect(removed).toMatchObject({ nextState: "CANCELLED", activityAction: "request_deleted" });
    denied(planTaskRequestTransition(marker("SUBMITTED"), executor, { action: "delete" }), "FORBIDDEN_ROLE");
    expect(allowed(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), executor, { action: "delete" })))
      .toMatchObject({ nextState: "CANCELLED", activityAction: "request_deleted" });
    const repeated = allowed(planTaskRequestTransition(marker("CANCELLED", "executor"), author, { action: "delete" }));
    expect(repeated.changed).toBe(false);
    denied(planTaskRequestTransition(marker("COMPLETED", "executor"), leader, { action: "delete" }), "INVALID_TRANSITION");
  });

  it("allows description edits only to author and executor before completion", () => {
    for (const [state, actorFacts, executorId] of [
      ["DRAFT", author, null],
      ["SUBMITTED", author, null],
      ["IN_PROGRESS", author, "executor"],
      ["IN_PROGRESS", executor, "executor"],
      ["NEEDS_INFO", author, "executor"],
      ["NEEDS_INFO", executor, "executor"],
    ] as const) {
      const plan = allowed(planTaskRequestTransition(marker(state, executorId), actorFacts, {
        action: "edit_description",
        description: "Новое описание",
        currentDescription: "Старое описание",
      }));
      expect(plan).toMatchObject({
        nextState: state,
        nextExecutorId: executorId,
        changed: true,
        activityAction: "description_changed",
      });
    }
    denied(planTaskRequestTransition(marker("SUBMITTED"), observer, {
      action: "edit_description",
      description: "text",
      currentDescription: "old",
    }), "FORBIDDEN_ROLE");
    denied(planTaskRequestTransition(marker("COMPLETED", "executor"), author, {
      action: "edit_description",
      description: "text",
      currentDescription: "old",
    }), "INVALID_TRANSITION");
    denied(planTaskRequestTransition(marker("CANCELLED", "executor"), author, {
      action: "edit_description",
      description: "text",
      currentDescription: "old",
    }), "INVALID_TRANSITION");
    denied(planTaskRequestTransition(marker("SUBMITTED"), author, { action: "edit_description" }), "DESCRIPTION_REQUIRED");
    const unchanged = allowed(planTaskRequestTransition(marker("SUBMITTED"), author, {
      action: "edit_description",
      description: "same",
      currentDescription: "same",
    }));
    expect(unchanged.changed).toBe(false);
  });

  it("does not let a description edit or ordinary comment unpause clarification", () => {
    const paused = marker("NEEDS_INFO", "executor");
    const edited = allowed(planTaskRequestTransition(paused, author, {
      action: "edit_description",
      description: "Уточнил описание",
      currentDescription: "old",
    }));
    expect(edited.nextState).toBe("NEEDS_INFO");
    expect(edited.nextExecutorId).toBe("executor");
  });

  it("rejects an actor whose supplied role facts disagree with the marker", () => {
    denied(planTaskRequestTransition(marker("DRAFT"), {
      actorId: "other",
      isAuthor: true,
      isExecutor: false,
      isLeader: false,
      canParticipate: true,
      canExecute: true,
    }, { action: "submit" }), "FORBIDDEN_ROLE");
    denied(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), {
      actorId: "other",
      isAuthor: false,
      isExecutor: true,
      isLeader: false,
      canParticipate: true,
      canExecute: true,
    }, { action: "complete" }), "FORBIDDEN_ROLE");
  });

  it("never widens the common project policy: no participation means no lifecycle action", () => {
    for (const [state, executorId, actorFacts, action] of [
      ["DRAFT", null, author, "submit"],
      ["DRAFT", null, author, "cancel"],
      ["SUBMITTED", null, observer, "take"],
      ["IN_PROGRESS", "executor", executor, "complete"],
      ["COMPLETED", "executor", author, "reopen"],
    ] as const) {
      denied(planTaskRequestTransition(
        marker(state, executorId),
        { ...actorFacts, canParticipate: false },
        action === "reopen" ? { action, reason: "why" } : { action },
      ), "FORBIDDEN_ROLE");
    }
  });

  it("requires the common write boundary for work actions even for a participant", () => {
    denied(planTaskRequestTransition(marker("SUBMITTED"), {
      ...observer,
      canExecute: false,
    }, { action: "take" }), "FORBIDDEN_ROLE");
    denied(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), {
      ...executor,
      canExecute: false,
    }, { action: "complete" }), "FORBIDDEN_ROLE");
    denied(planTaskRequestTransition(marker("IN_PROGRESS", "executor"), {
      ...leader,
      canExecute: false,
    }, { action: "cancel" }), "FORBIDDEN_ROLE");
    // The author's own transitions do not require the board write right.
    expect(allowed(planTaskRequestTransition(marker("DRAFT"), author, { action: "submit" })))
      .toMatchObject({ nextState: "SUBMITTED" });
  });
});

describe("content writers on a marked request", () => {
  const participant = {
    actorId: "observer",
    isAuthor: false,
    isExecutor: false,
    isWatcher: false,
    isGroupMember: false,
    isLeader: false,
  };
  const groupMember = { ...participant, actorId: "group-member", isGroupMember: true };
  const watcher = { ...participant, actorId: "watcher", isWatcher: true };
  const stranger = { ...participant, actorId: "stranger" };

  function contentDenied(decision: TaskRequestContentDecision, code: string): void {
    expect(decision).toEqual({ allowed: false, code });
  }

  it.each(["comment", "attachment"] as const)("lets participants add a %s without a transition", (kind) => {
    expect(planTaskRequestContentMutation(marker("DRAFT"), {
      ...participant,
      actorId: "author",
      isAuthor: true,
    }, kind)).toEqual({ allowed: true });
    expect(planTaskRequestContentMutation(marker("IN_PROGRESS", "executor"), {
      ...participant,
      actorId: "executor",
      isExecutor: true,
    }, kind)).toEqual({ allowed: true });
    // Adding content never clears the clarification state.
    expect(planTaskRequestContentMutation(marker("NEEDS_INFO", "executor"), watcher, kind))
      .toEqual({ allowed: true });
    expect(planTaskRequestContentMutation(marker("SUBMITTED"), groupMember, kind))
      .toEqual({ allowed: true });
    expect(planTaskRequestContentMutation(marker("SUBMITTED"), {
      ...participant,
      actorId: "leader",
      isLeader: true,
    }, kind)).toEqual({ allowed: true });
  });

  it.each(["comment", "attachment"] as const)("denies strangers and cancelled requests for %s", (kind) => {
    contentDenied(planTaskRequestContentMutation(marker("SUBMITTED"), stranger, kind), "FORBIDDEN_ROLE");
    contentDenied(planTaskRequestContentMutation(marker("CANCELLED"), watcher, kind), "INVALID_TRANSITION");
    // A draft is the author's private area until it is submitted.
    contentDenied(planTaskRequestContentMutation(marker("DRAFT"), groupMember, kind), "FORBIDDEN_ROLE");
    contentDenied(planTaskRequestContentMutation(marker("DRAFT"), watcher, kind), "FORBIDDEN_ROLE");
  });

  it("rejects an unknown content kind", () => {
    contentDenied(planTaskRequestContentMutation(marker("SUBMITTED"), watcher, "status" as never), "INVALID_LIFECYCLE_ACTION");
  });
});

describe("BezNal independent revision phase",()=>{
 const marker={taskId:"task",contractVersion:1 as const,state:"IN_PROGRESS" as const,authorId:"author",executorId:"accountant"};
 const sales={actorId:"sales",isAuthor:false,isExecutor:false,isLeader:false,canParticipate:true,canExecute:false,canReturnForRevision:true,beznalPhase:"INVOICED" as const};
 it("requires explicit return permission/reason and retains canonical state/executor",()=>{
  expect(planTaskRequestTransition(marker,sales,{action:"return_for_revision",reason:"Исправить сумму"})).toMatchObject({allowed:true,changed:true,nextState:"IN_PROGRESS",nextExecutorId:"accountant",activityAction:"request_returned_for_revision",activity:{newValue:{beznalPhase:"WAITING"}}});
  expect(planTaskRequestTransition(marker,{...sales,canReturnForRevision:false},{action:"return_for_revision",reason:"Исправить"})).toEqual({allowed:false,code:"FORBIDDEN_ROLE"});
  expect(planTaskRequestTransition(marker,sales,{action:"return_for_revision"})).toEqual({allowed:false,code:"REASON_REQUIRED"});
  expect(planTaskRequestTransition(marker,{...sales,beznalPhase:"WAITING"},{action:"return_for_revision",reason:"Исправить"})).toMatchObject({allowed:true,changed:false});
 });
 it("does not turn return privilege into take/assign/complete",()=>{
  for(const action of ["take","assign","complete"] as const)expect(planTaskRequestTransition(marker,sales,{action,assigneeId:"sales"})).toEqual({allowed:false,code:"FORBIDDEN_ROLE"});
  expect(taskRequestLifecycleCommandSchema.safeParse({operationId:"11111111-1111-4111-8111-111111111111",expectedVersion:3,action:"return_for_revision",reason:"  "}).success).toBe(false);
 });
});

it("explicit invoice command is strict and requires canonical file URL only for that action",()=>{
 const base={operationId:"11111111-1111-4111-8111-111111111111",expectedVersion:3};
 expect(taskRequestLifecycleCommandSchema.safeParse({...base,action:"mark_invoice_ready"}).success).toBe(false);
 expect(taskRequestLifecycleCommandSchema.safeParse({...base,action:"mark_invoice_ready",invoiceUrl:"https://foreign.test/invoice.pdf"}).success).toBe(false);
 expect(taskRequestLifecycleCommandSchema.safeParse({...base,action:"mark_invoice_ready",invoiceUrl:"/api/tasks/task/files/file-id"}).success).toBe(true);
 expect(taskRequestLifecycleCommandSchema.safeParse({...base,action:"approve",invoiceUrl:"/api/tasks/task/files/file-id"}).success).toBe(false);
});
it("archived return without executor reenters free queue but CANCELLED cannot be restored",()=>{
 const facts={...author,isBeznal:true,beznalPhase:"WAITING" as const};
 expect(planTaskRequestTransition(marker("CLOSED"),facts,{action:"return_for_revision",reason:"Correct"})).toMatchObject({allowed:true,nextState:"SUBMITTED",nextExecutorId:null,changed:true});
 expect(planTaskRequestTransition(marker("CANCELLED"),facts,{action:"return_for_revision",reason:"Correct"})).toEqual({allowed:false,code:"INVALID_TRANSITION"});
});
