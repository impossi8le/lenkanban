"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiPatch, type ApiTelemetryContext } from "@/lib/api";
import type { TaskType } from "@/components/kanban/Card";
import type { TaskSaveCallbacks } from "@/components/task/TaskDetailPanel";
import { modalScalarChanges, patchScalarCommand, readTaskDetails, type ModalTaskSave, type ScalarCommand } from "@/lib/task-scalar-transport";

type Phase = "idle" | "saving" | "unknown" | "conflict" | "unsupported" | "reading" | "readFailed" | "denied" | "rejected";
type Pending = { kind: "scalar"; command: ScalarCommand; callbacks?: TaskSaveCallbacks } | { kind: "move"; actionId: string; callbacks?: TaskSaveCallbacks };
function status(error: unknown): number | undefined { try { return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined; } catch { return undefined; } }
function unsupportedFields(error: unknown): boolean { try { return (error as { payload?: { error?: { code?: unknown } } })?.payload?.error?.code === "REQUEST_LIFECYCLE_NOT_ENABLED"; } catch { return false; } }
function notify(callback: (() => void) | undefined) { try { callback?.(); } catch { /* A consumer cannot turn a committed write into a failed command. */ } }

export function useTaskScalarCommand(initialTask: TaskType, projectId: string, taskId: string, onAuthoritativeRead?: (task: TaskType) => void) {
  const client = useQueryClient();
  const [snapshot, setSnapshot] = useState<{ source: TaskType; task: TaskType } | null>(null);
  const [phase, setPhase] = useState<Phase>("idle"), [generation, setGeneration] = useState(0);
  const currentTask = snapshot?.source === initialTask ? snapshot.task : initialTask;
  const current = useRef(currentTask), source = useRef(initialTask); current.current = currentTask; source.current = initialTask;
  const authoritativeRead = useRef(onAuthoritativeRead); authoritativeRead.current = onAuthoritativeRead;
  const pending = useRef<Pending | null>(null), busy = useRef(false), phaseRef = useRef<Phase>("idle"), scope = useRef(0), mustRemount = useRef(false);
  const denied = useRef(false), staleVersion = useRef<number | null>(null);
  // The mounted editor explicitly opts into clean refreshes only after its
  // actor-scoped draft has loaded. Input events update this ref synchronously.
  const localEdits = useRef({ dirty: true, revision: 0 });
  const reportLocalEdits = useCallback((dirty: boolean, inputEvent = false) => {
    if (inputEvent) localEdits.current.revision++;
    localEdits.current.dirty = dirty;
  }, []);
  const transition = useCallback((value: Phase) => {
    if (value === "denied") denied.current = true;
    if (denied.current && value !== "denied") return;
    const next = ["idle", "rejected"].includes(value) && staleVersion.current !== null ? "conflict" : value;
    phaseRef.current = next; setPhase(next);
  }, []);
  useEffect(() => () => { scope.current++; pending.current = null; }, []);
  const invalidate = useCallback(() => {
    void Promise.allSettled([
      client.invalidateQueries({ queryKey: ["tasks", projectId] }),
      client.invalidateQueries({ queryKey: ["task", taskId], exact: true }),
      client.invalidateQueries({ queryKey: ["activities", taskId] }),
      client.invalidateQueries({ queryKey: ["task-lifecycle", taskId] }),
    ]).catch(() => undefined);
  }, [client, projectId, taskId]);
  const read = useCallback(async (actionId: string, requestScope: number, recovery = false, confirmedVersion?: number) => {
    transition("reading");
    try {
      const value = await readTaskDetails(taskId, { actionId });
      if (requestScope !== scope.current || denied.current) return;
      if (value.id !== taskId || value.projectId !== projectId || !Number.isInteger(value.version) || value.version! < 0 || value.version! > 2147483647) throw new Error("INVALID_DETAILS");
      if (confirmedVersion !== undefined) {
        if (value.version! > confirmedVersion) {
          staleVersion.current = Math.max(staleVersion.current ?? 0, value.version!);
          mustRemount.current = true;
        } else if (value.version === confirmedVersion && staleVersion.current !== null && staleVersion.current <= confirmedVersion) {
          // This exact increment is proven by our frozen command's ACK. Its own
          // realtime echo does not require a second user conflict-recovery action.
          staleVersion.current = null;
        }
      }
      if (recovery && staleVersion.current !== null && value.version! < staleVersion.current) throw new Error("STALE_DETAILS");
      const latest = typeof current.current.version === "number" && current.current.version > value.version! ? current.current : value;
      setSnapshot({ source: source.current, task: latest }); current.current = latest;
      const callbacks = pending.current?.callbacks; pending.current = null;
      if (recovery) { staleVersion.current = null; setGeneration(value => value + 1); }
      if (staleVersion.current === null) mustRemount.current = false;
      transition("idle"); invalidate();
      try { void Promise.resolve(authoritativeRead.current?.(latest)).catch(() => undefined); } catch { /* A notification cannot replace the authoritative read result. */ }
      if (!recovery) notify(() => callbacks?.onSuccess(latest));
    } catch (error) {
      if (requestScope !== scope.current || denied.current) return;
      const code = status(error);
      transition(code === 401 || code === 403 || code === 404 ? "denied" : "readFailed");
    }
  }, [invalidate, projectId, taskId, transition]);
  const execute = useCallback(async (entry: Extract<Pending, { kind: "scalar" }>) => {
    if (busy.current) return;
    busy.current = true; pending.current = entry; transition("saving"); const requestScope = scope.current;
    try {
      const ack = await patchScalarCommand(entry.command);
      if (requestScope !== scope.current || denied.current) return;
      if (ack.taskId !== taskId || ack.projectId !== projectId) { transition("readFailed"); return; }
      const confirmedVersion = Number.isInteger(ack.version) && ack.version === entry.command.body.expectedVersion + 1 ? ack.version : undefined;
      await read(entry.command.actionId, requestScope, false, confirmedVersion);
    } catch (error) {
      if (requestScope !== scope.current || denied.current) return;
      const code = status(error);
      if (code === undefined || code >= 500) transition("unknown");
      else { notify(entry.callbacks?.onError); if (code === 409) mustRemount.current = true; transition(code === 409 ? unsupportedFields(error) ? "unsupported" : "conflict" : code === 401 || code === 403 || code === 404 ? "denied" : "rejected"); if (code !== 409) pending.current = null; }
    } finally { if (requestScope === scope.current) busy.current = false; }
  }, [projectId, read, taskId, transition]);
  const save = useCallback((id: string, data: ModalTaskSave, callbacks?: TaskSaveCallbacks, startTelemetry?: () => ApiTelemetryContext | undefined) => {
    if (id !== taskId || busy.current || !["idle", "rejected"].includes(phaseRef.current)) return;
    if (Object.hasOwn(data, "columnId")) {
      if (!data.columnId || ["description", "priority", "deadline"].some(key => Object.hasOwn(data, key))) { notify(callbacks?.onError); transition("rejected"); return; }
      let telemetry: ApiTelemetryContext | undefined; try { telemetry = startTelemetry?.(); } catch { /* Diagnostics cannot block an accepted command. */ }
      let actionId: string; try { actionId = telemetry?.actionId ?? crypto.randomUUID(); } catch { notify(callbacks?.onError); transition("rejected"); return; }
      pending.current = { kind: "move", actionId, callbacks }; busy.current = true; transition("saving"); const requestScope = scope.current;
      // Movement remains the existing canonical legacy route, separate from scalar commands.
      void apiPatch<TaskType>(`/api/tasks/${encodeURIComponent(taskId)}`, { columnId: data.columnId, expectedVersion: data.expectedVersion ?? current.current.version }, { actionId, ...(telemetry?.onResult ? { onResult: telemetry.onResult } : {}) }).then(async () => {
        if (requestScope === scope.current && !denied.current) await read(actionId, requestScope);
      }, error => {
        if (requestScope !== scope.current || denied.current) return;
        notify(callbacks?.onError); const code = status(error); if (code === 409) mustRemount.current = true; transition(code === 401 || code === 403 || code === 404 ? "denied" : code === 409 ? "conflict" : "readFailed");
      }).finally(() => { if (requestScope === scope.current) busy.current = false; });
      return;
    }
    try {
      const changes = modalScalarChanges(data, current.current);
      if (!Object.keys(changes).length) { notify(() => callbacks?.onSuccess(current.current)); return; }
      const version = current.current.version;
      if (!Number.isInteger(version) || version! < 0 || version! > 2147483647) { mustRemount.current = true; transition("conflict"); notify(callbacks?.onError); return; }
      let telemetry: ApiTelemetryContext | undefined; try { telemetry = startTelemetry?.(); } catch { /* Diagnostics cannot block an accepted command. */ }
      const command: ScalarCommand = { taskId, projectId, actionId: telemetry?.actionId ?? crypto.randomUUID(), ...(telemetry?.onResult ? { onResult: telemetry.onResult } : {}), body: { operationId: crypto.randomUUID(), expectedVersion: version!, changes } };
      void execute({ kind: "scalar", command, callbacks });
    } catch { notify(callbacks?.onError); transition("rejected"); }
  }, [execute, projectId, read, taskId, transition]);
  const readInBackground = useCallback(async () => {
    const requestScope = scope.current;
    const revision = localEdits.current.revision;
    const startedClean = !localEdits.current.dirty && !busy.current && pending.current === null && staleVersion.current === null && ["idle", "rejected"].includes(phaseRef.current);
    try {
      const value = await readTaskDetails(taskId, { actionId: crypto.randomUUID() });
      if (requestScope !== scope.current || denied.current) return;
      if (value.id !== taskId || value.projectId !== projectId || !Number.isInteger(value.version)
        || value.version! < 0 || value.version! > 2147483647) return;
      if (typeof current.current.version === "number" && value.version! > current.current.version) {
        if (startedClean && !localEdits.current.dirty && localEdits.current.revision === revision && !busy.current && pending.current === null && staleVersion.current === null && ["idle", "rejected"].includes(phaseRef.current)) {
          // A clean card follows assignment/status changes without a synthetic
          // conflict. Never adopt this version for text typed during the read.
          current.current = value; setSnapshot({ source: source.current, task: value });
          invalidate();
          try { void Promise.resolve(authoritativeRead.current?.(value)).catch(() => undefined); } catch { /* Host refresh cannot affect the authoritative result. */ }
          return;
        }
        // Retained input, unresolved commands and real conflicts keep their
        // original version until explicit conflict recovery.
        staleVersion.current = Math.max(staleVersion.current ?? 0, value.version!);
        mustRemount.current = true;
        if (["idle", "rejected"].includes(phaseRef.current)) transition("conflict");
      }
    } catch (error) {
      if (requestScope !== scope.current || denied.current) return;
      if ([401, 403, 404].includes(status(error) ?? 0)) {
        // Revocation outranks unknown/saving outcomes. Preserve the frozen command,
        // but no later response may reveal it again in this mounted task scope.
        denied.current = true; transition("denied");
      }
    }
  }, [invalidate, projectId, taskId, transition]);
  const retry = useCallback(() => { const entry = pending.current; if (phaseRef.current === "unknown" && entry?.kind === "scalar") void execute(entry); }, [execute]);
  const refresh = useCallback(() => {
    if (denied.current || busy.current || phaseRef.current === "unknown") return;
    let actionId: string; try { const entry = pending.current; actionId = entry?.kind === "scalar" ? entry.command.actionId : entry?.actionId ?? crypto.randomUUID(); } catch { return; }
    const recovery = mustRemount.current; busy.current = true; const requestScope = scope.current;
    void read(actionId, requestScope, recovery).finally(() => { if (requestScope === scope.current) busy.current = false; });
  }, [read]);
  return { task: currentTask, phase, generation, save, retry, refresh, readInBackground, reportLocalEdits, blocked: !["idle", "rejected"].includes(phase), busy: phase === "saving" || phase === "reading" };
}
