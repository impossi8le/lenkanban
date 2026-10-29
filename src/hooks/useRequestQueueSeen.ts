"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

type Status = "idle" | "pending" | "seen" | "failed";
type Phase = Status | "scheduled" | "stale";
type Attempt = { key: string; phase: Phase; generation: number };
export interface RequestQueueSeenOptions {
  actorId?: string | null;
  taskId?: string | null;
  queueArrival?: { epoch: number; unseen: boolean } | null;
  authoritative: boolean;
  active: boolean;
  onAcknowledged?: () => void;
  onStale?: () => void;
}

/** A receipt follows a successfully rendered, focused card, never a prefetch. */
export function useRequestQueueSeen(options: RequestQueueSeenOptions) {
  const { actorId, taskId, queueArrival, authoritative, active } = options;
  const epoch = queueArrival?.epoch;
  const key = actorId && taskId && Number.isInteger(epoch) && epoch! > 0 && epoch! <= 2147483647
    ? JSON.stringify([actorId, taskId, epoch]) : "";
  const eligible = Boolean(key && queueArrival?.unseen && authoritative && active);
  const callbacks = useRef(options);
  const attempt = useRef<Attempt>({ key: "", phase: "idle", generation: 0 });
  const [view, setView] = useState({ key: "", status: "idle" as Status });
  const [retryNumber, setRetryNumber] = useState(0);
  useEffect(() => { callbacks.current = options; });

  useEffect(() => {
    if (attempt.current.key !== key) attempt.current = { key, phase: "idle", generation: 0 };
    const record = attempt.current;
    if (authoritative && queueArrival?.unseen === false) record.phase = "seen";
    let frame: number | undefined;
    let controller: AbortController | undefined;
    let alive = true;
    const current = (generation: number) => alive && attempt.current === record && record.generation === generation;
    const publish = (status: Status) => setView({ key, status });
    const visible = () => document.visibilityState === "visible" && document.hasFocus();
    const cancelPending = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      controller?.abort();
      controller = undefined;
      record.generation++;
      if (record.phase === "scheduled" || record.phase === "pending") record.phase = "idle";
    };
    const schedule = () => {
      if (!eligible || !visible() || record.phase !== "idle") return;
      record.phase = "scheduled";
      const generation = ++record.generation;
      frame = requestAnimationFrame(() => {
        if (!current(generation)) return;
        // RAF callbacks run before paint. A second frame lets the first visible
        // card frame be presented before a persisted view receipt is sent.
        frame = requestAnimationFrame(() => {
        frame = undefined;
        if (!current(generation)) return;
        if (!visible()) { record.phase = "idle"; return; }
        record.phase = "pending";
        publish("pending");
        controller = new AbortController();
        void apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId!)}/queue-seen`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ queueEpoch: epoch, expectedActorId: actorId }), signal: controller.signal,
        }).then(response => {
          if (!current(generation)) return;
          if (!response || typeof response !== "object"
            || typeof (response as { changed?: unknown }).changed !== "boolean"
            || typeof (response as { stale?: unknown }).stale !== "boolean") throw new Error("Invalid queue receipt");
          const stale = (response as { stale: boolean }).stale;
          record.phase = stale ? "stale" : "seen";
          publish(stale ? "idle" : "seen");
          // A consumer callback cannot turn a persisted acknowledgement into a failed view.
          try { if (stale) callbacks.current.onStale?.(); else callbacks.current.onAcknowledged?.(); } catch { /* Consumer owns its refresh. */ }
        }).catch(() => {
          if (!current(generation)) return;
          record.phase = "failed";
          publish("failed");
        });
        });
      });
    };
    const onVisibility = () => {
      if (!visible()) { cancelPending(); publish(record.phase === "seen" ? "seen" : record.phase === "failed" ? "failed" : "idle"); }
      else schedule();
    };
    publish(record.phase === "seen" ? "seen" : record.phase === "failed" ? "failed" : "idle");
    if (eligible) {
      window.addEventListener("focus", onVisibility);
      window.addEventListener("blur", onVisibility);
      document.addEventListener("visibilitychange", onVisibility);
      schedule();
    }
    return () => {
      alive = false;
      cancelPending();
      window.removeEventListener("focus", onVisibility);
      window.removeEventListener("blur", onVisibility);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [key, eligible, actorId, taskId, epoch, retryNumber, authoritative, queueArrival?.unseen]);

  const retry = useCallback(() => {
    if (eligible && attempt.current.key === key && attempt.current.phase === "failed") {
      attempt.current.phase = "idle";
      setRetryNumber(value => value + 1);
    }
  }, [key, eligible]);
  return { status: view.key === key ? view.status : "idle" as Status, retry };
}
