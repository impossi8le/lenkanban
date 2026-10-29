"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

type ReceiptStatus = "idle" | "pending" | "seen" | "failed";
type Attempt = { key: string; phase: ReceiptStatus | "scheduled"; generation: number };

/** Confirm the snapshot actually rendered in a focused, visible detail panel. */
export function useTaskChangeViewed({ actorId, projectId, taskId, snapshotToken, ready, unseen, notificationCount = 0 }: {
  actorId?: string; projectId: string; taskId: string; snapshotToken?: string; ready: boolean; unseen?: boolean; notificationCount?: number;
}) {
  const client = useQueryClient();
  const key = actorId && snapshotToken ? JSON.stringify([actorId, taskId, snapshotToken]) : "";
  const eligible = Boolean(key && ready && (unseen || notificationCount > 0));
  const attempt = useRef<Attempt>({ key: "", phase: "idle", generation: 0 });
  const [view, setView] = useState({ key: "", status: "idle" as ReceiptStatus });
  const [retryNumber, setRetryNumber] = useState(0);
  useEffect(() => {
    if (attempt.current.key !== key) attempt.current = { key, phase: "idle", generation: 0 };
    const record = attempt.current;
    let frame: number | undefined;
    let controller: AbortController | undefined;
    let alive = true;
    const current = (generation: number) => alive && attempt.current === record && record.generation === generation;
    const visible = () => document.visibilityState === "visible" && document.hasFocus();
    const cancel = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      controller?.abort(); frame = undefined; controller = undefined; record.generation++;
      if (record.phase === "scheduled" || record.phase === "pending") record.phase = "idle";
    };
    const schedule = () => {
      if (!eligible || !visible() || record.phase !== "idle") return;
      record.phase = "scheduled";
      const generation = ++record.generation;
      frame = requestAnimationFrame(() => {
        if (!current(generation)) return;
        frame = requestAnimationFrame(() => {
          frame = undefined;
          if (!current(generation)) return;
          if (!visible()) { record.phase = "idle"; return; }
          record.phase = "pending"; setView({ key, status: "pending" });
          controller = new AbortController();
          void apiFetch<{ changed: boolean; stale: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/viewed`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedActorId: actorId, snapshotToken }), signal: controller.signal,
          }).then(result => {
            if (!current(generation)) return;
            if (typeof result?.changed !== "boolean" || typeof result?.stale !== "boolean") throw new Error("INVALID_VIEW_RECEIPT");
            record.phase = "seen"; setView({ key, status: "seen" });
            void client.invalidateQueries({ queryKey: ["task-changes", actorId, projectId] });
            void client.invalidateQueries({ queryKey: ["notifications", actorId] });
          }).catch(() => {
            if (!current(generation)) return;
            record.phase = "failed"; setView({ key, status: "failed" });
          });
        });
      });
    };
    const visibility = () => { if (!visible()) cancel(); else schedule(); };
    if (eligible) {
      window.addEventListener("focus", visibility); window.addEventListener("blur", visibility);
      document.addEventListener("visibilitychange", visibility); schedule();
    }
    return () => {
      alive = false; cancel(); window.removeEventListener("focus", visibility); window.removeEventListener("blur", visibility);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [key, eligible, actorId, projectId, taskId, snapshotToken, client, retryNumber]);
  const retry = useCallback(() => {
    if (attempt.current.key === key && attempt.current.phase === "failed") {
      attempt.current.phase = "idle"; setRetryNumber(value => value + 1);
    }
  }, [key]);
  return { status: view.key === key ? view.status : "idle" as ReceiptStatus, retry };
}
