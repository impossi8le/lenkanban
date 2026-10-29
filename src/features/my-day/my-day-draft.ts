"use client";

import { useEffect } from "react";
import { isDayKey, MY_DAY_MAX_LENGTH } from "@/lib/my-day-contract";

export const MY_DAY_DRAFT_PREFIX = "lenkanban:my-day:draft:";
export const MY_DAY_ACTOR_KEY = "lenkanban:my-day:actor";

export interface MyDayDraft {
  actorId: string;
  date: string;
  text: string;
  baseVersion: number;
}

export interface MyDayDraftStorageResult<T = void> {
  storageAvailable: boolean;
  value: T;
}

const trackedKeys = new Set<string>();
let lastObservedActorId: string | null = null;

export function getMyDayDraftKey(actorId: string, date: string): string {
  return `${MY_DAY_DRAFT_PREFIX}${actorId}:${date}`;
}

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isValidDraft(candidate: unknown, expectedActorId?: string, expectedDate?: string): candidate is MyDayDraft {
  if (!candidate || typeof candidate !== "object") return false;
  const record = candidate as Record<string, unknown>;
  if (typeof record.actorId !== "string" || !record.actorId.trim()) return false;
  if (expectedActorId && record.actorId !== expectedActorId) return false;
  if (!isDayKey(record.date)) return false;
  if (expectedDate && record.date !== expectedDate) return false;
  if (typeof record.text !== "string" || record.text.length > MY_DAY_MAX_LENGTH) return false;
  if (typeof record.baseVersion !== "number" || !Number.isInteger(record.baseVersion) || record.baseVersion < 0) {
    return false;
  }
  return true;
}

function collectMyDayStorageKeys(storage: Storage): string[] {
  const keys = new Set<string>(trackedKeys);
  keys.add(MY_DAY_ACTOR_KEY);
  try {
    const length = typeof storage.length === "number" ? storage.length : 0;
    for (let index = 0; index < length; index += 1) {
      const key = storage.key?.(index);
      if (key && (key === MY_DAY_ACTOR_KEY || key.startsWith(MY_DAY_DRAFT_PREFIX))) {
        keys.add(key);
      }
    }
  } catch {
    // Ignore enumeration errors on partial Storage implementations.
  }
  return Array.from(keys);
}

/**
 * Remove all My Day drafts and actor markers from sessionStorage (e.g. on logout or actor switch).
 */
export function clearAllMyDayDrafts(): boolean {
  const storage = getSessionStorage();
  if (!storage) {
    trackedKeys.clear();
    return false;
  }
  try {
    for (const key of collectMyDayStorageKeys(storage)) {
      storage.removeItem(key);
    }
    trackedKeys.clear();
    return true;
  } catch {
    trackedKeys.clear();
    return false;
  }
}

/**
 * Remove any drafts belonging to an actor other than `actorId`.
 */
export function clearForeignMyDayDrafts(actorId: string): boolean {
  if (!actorId) return clearAllMyDayDrafts();
  const storage = getSessionStorage();
  if (!storage) return false;
  try {
    const storedActor = storage.getItem(MY_DAY_ACTOR_KEY);
    if (storedActor && storedActor !== actorId) {
      clearAllMyDayDrafts();
    }
    const ownPrefix = `${MY_DAY_DRAFT_PREFIX}${actorId}:`;
    for (const key of collectMyDayStorageKeys(storage)) {
      if (key === MY_DAY_ACTOR_KEY) continue;
      if (!key.startsWith(ownPrefix)) {
        storage.removeItem(key);
        trackedKeys.delete(key);
        continue;
      }
      const raw = storage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!isValidDraft(parsed, actorId)) {
          storage.removeItem(key);
          trackedKeys.delete(key);
        }
      } catch {
        storage.removeItem(key);
        trackedKeys.delete(key);
      }
    }
    storage.setItem(MY_DAY_ACTOR_KEY, actorId);
    trackedKeys.add(MY_DAY_ACTOR_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile sessionStorage drafts against the current NextAuth session state.
 */
export function reconcileMyDaySessionDrafts(
  actorId: string | null | undefined,
  status: "loading" | "authenticated" | "unauthenticated",
): void {
  if (status === "unauthenticated") {
    lastObservedActorId = null;
    clearAllMyDayDrafts();
    return;
  }
  if (status === "authenticated") {
    const normalized = actorId?.trim() || null;
    if (!normalized) {
      lastObservedActorId = null;
      clearAllMyDayDrafts();
      return;
    }
    if (lastObservedActorId && lastObservedActorId !== normalized) {
      clearAllMyDayDrafts();
    }
    lastObservedActorId = normalized;
    clearForeignMyDayDrafts(normalized);
  }
}

/**
 * Effect-based session guard that clears sessionStorage drafts on logout or user switch.
 */
export function useMyDaySessionGuard(
  actorId: string | null | undefined,
  status: "loading" | "authenticated" | "unauthenticated" = actorId ? "authenticated" : "loading",
): void {
  useEffect(() => {
    reconcileMyDaySessionDrafts(actorId, status);
  }, [actorId, status]);
}

/**
 * Probe and read a draft for `(actorId, date)` from sessionStorage.
 */
export function readMyDayDraft(
  actorId: string,
  date: string,
): MyDayDraftStorageResult<MyDayDraft | null> {
  const storage = getSessionStorage();
  if (!storage) {
    return { storageAvailable: false, value: null };
  }
  try {
    const probeKey = `${MY_DAY_DRAFT_PREFIX}__probe__`;
    storage.setItem(probeKey, "1");
    storage.removeItem(probeKey);

    clearForeignMyDayDrafts(actorId);
    const key = getMyDayDraftKey(actorId, date);
    const raw = storage.getItem(key);
    if (!raw) {
      return { storageAvailable: true, value: null };
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isValidDraft(parsed, actorId, date)) {
        storage.removeItem(key);
        trackedKeys.delete(key);
        return { storageAvailable: true, value: null };
      }
      trackedKeys.add(key);
      return { storageAvailable: true, value: parsed };
    } catch {
      storage.removeItem(key);
      trackedKeys.delete(key);
      return { storageAvailable: true, value: null };
    }
  } catch {
    return { storageAvailable: false, value: null };
  }
}

/**
 * Persist a draft for `(actorId, date)` to sessionStorage.
 */
export function writeMyDayDraft(draft: MyDayDraft): MyDayDraftStorageResult<void> {
  const storage = getSessionStorage();
  if (!storage) {
    return { storageAvailable: false, value: undefined };
  }
  try {
    clearForeignMyDayDrafts(draft.actorId);
    const key = getMyDayDraftKey(draft.actorId, draft.date);
    storage.setItem(MY_DAY_ACTOR_KEY, draft.actorId);
    storage.setItem(key, JSON.stringify(draft));
    trackedKeys.add(MY_DAY_ACTOR_KEY);
    trackedKeys.add(key);
    return { storageAvailable: true, value: undefined };
  } catch {
    return { storageAvailable: false, value: undefined };
  }
}

/**
 * Explicitly remove a draft for `(actorId, date)` from sessionStorage.
 */
export function removeMyDayDraft(actorId: string, date: string): MyDayDraftStorageResult<void> {
  const storage = getSessionStorage();
  if (!storage) {
    return { storageAvailable: false, value: undefined };
  }
  try {
    const key = getMyDayDraftKey(actorId, date);
    storage.removeItem(key);
    trackedKeys.delete(key);
    return { storageAvailable: true, value: undefined };
  } catch {
    return { storageAvailable: false, value: undefined };
  }
}

/**
 * Clear the draft for `(actorId, date)` ONLY if the server-confirmed text matches
 * both the stored draft text and the current editor text.
 */
export function settleMyDayDraftOnConfirm(params: {
  actorId: string;
  date: string;
  confirmedText: string;
  confirmedVersion: number;
  currentEditorText: string;
}): MyDayDraftStorageResult<void> {
  const { actorId, date, confirmedText, confirmedVersion, currentEditorText } = params;
  const storage = getSessionStorage();
  if (!storage) {
    return { storageAvailable: false, value: undefined };
  }
  try {
    const key = getMyDayDraftKey(actorId, date);
    if (currentEditorText === confirmedText) {
      const raw = storage.getItem(key);
      if (!raw) {
        trackedKeys.delete(key);
        return { storageAvailable: true, value: undefined };
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!isValidDraft(parsed, actorId, date) || parsed.text === confirmedText) {
          storage.removeItem(key);
          trackedKeys.delete(key);
        }
      } catch {
        storage.removeItem(key);
        trackedKeys.delete(key);
      }
      return { storageAvailable: true, value: undefined };
    }

    const nextDraft: MyDayDraft = {
      actorId,
      date,
      text: currentEditorText,
      baseVersion: confirmedVersion,
    };
    storage.setItem(MY_DAY_ACTOR_KEY, draftActorOrFallback(actorId));
    storage.setItem(key, JSON.stringify(nextDraft));
    trackedKeys.add(MY_DAY_ACTOR_KEY);
    trackedKeys.add(key);
    return { storageAvailable: true, value: undefined };
  } catch {
    return { storageAvailable: false, value: undefined };
  }
}

function draftActorOrFallback(actorId: string): string {
  return actorId;
}
