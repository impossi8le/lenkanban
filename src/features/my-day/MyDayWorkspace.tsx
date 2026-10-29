"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Calendar as CalendarIcon,
  CheckCircle2,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { MY_DAY_ACTOR_HEADER, MY_DAY_SESSION_CHANGED } from "@/lib/my-day-contract";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MyDayCalendar } from "./MyDayCalendar";
import { Textarea } from "@/components/ui/textarea";
import {
  createMyDayOperationId,
  dayKeyToCalendarDate,
  formatMyDayHeading,
  isDayKey,
  msUntilNextMoscowMidnight,
  MY_DAY_MAX_LENGTH,
  shiftDayKey,
  todayMoscow,
  type MyDayEntry,
} from "./my-day-dates";
import {
  clearAllMyDayDrafts,
  readMyDayDraft,
  removeMyDayDraft,
  settleMyDayDraftOnConfirm,
  useMyDaySessionGuard,
  writeMyDayDraft,
} from "./my-day-draft";

export const MY_DAY_AUTOSAVE_DELAY_MS = 1_000;

function isSessionChanged(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; payload?: { error?: { code?: unknown } } };
  return value.status === 403 && value.payload?.error?.code === MY_DAY_SESSION_CHANGED;
}

interface PendingSaveIntent {
  actorId: string;
  date: string;
  text: string;
  expectedVersion: number;
  operationId: string;
}

function isValidMyDayEntry(value: unknown): value is MyDayEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    isDayKey(record.date) &&
    typeof record.text === "string" &&
    typeof record.version === "number" &&
    Number.isInteger(record.version) &&
    record.version >= 0 &&
    (record.updatedAt === null || typeof record.updatedAt === "string") &&
    isDayKey(record.today)
  );
}

function extractConflictCurrent(error: unknown): MyDayEntry | null {
  if (!error || typeof error !== "object") return null;
  const err = error as Record<string, unknown>;
  const status = err.status;
  const payload = err.payload as Record<string, unknown> | undefined;
  const nestedError = (payload?.error ?? err.error) as Record<string, unknown> | undefined;
  const isConflict =
    status === 409 ||
    nestedError?.code === "CONFLICT" ||
    err.code === "CONFLICT";
  if (!isConflict) return null;

  const details = (nestedError?.details ?? payload?.details ?? err.details) as
    | Record<string, unknown>
    | undefined;
  const current = details?.current;
  if (isValidMyDayEntry(current)) {
    return current;
  }
  return null;
}

function extractErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message && error.message !== "Request failed") {
    return error.message;
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const payload = record.payload as Record<string, unknown> | undefined;
    const nested = payload?.error as Record<string, unknown> | undefined;
    if (typeof nested?.message === "string" && nested.message.trim()) {
      return nested.message;
    }
    if (typeof record.message === "string" && record.message.trim() && record.message !== "Request failed") {
      return record.message;
    }
  }
  return fallback;
}

export interface MyDayWorkspaceProps {
  actorId: string;
  onSessionChanged?: () => Promise<unknown>;
}

export function MyDayWorkspace({ actorId, onSessionChanged }: MyDayWorkspaceProps) {
  useMyDaySessionGuard(actorId, "authenticated");

  const router = useRouter();
  const pathname = usePathname() || "/my-day";
  const searchParams = useSearchParams();
  const urlDateParam = searchParams?.get("date") ?? null;

  const [today, setToday] = React.useState<string>(() => todayMoscow());
  const todayRef = React.useRef<string>(today);
  todayRef.current = today;

  const initialDate = React.useMemo(() => {
    const initialToday = todayMoscow();
    if (isDayKey(urlDateParam) && urlDateParam <= initialToday) {
      return urlDateParam;
    }
    return initialToday;
  }, [urlDateParam]);

  const [selectedDate, setSelectedDate] = React.useState<string>(initialDate);
  const [calendarMonth, setCalendarMonth] = React.useState<Date>(() =>
    dayKeyToCalendarDate(initialDate),
  );
  const [mobileCalendarOpen, setMobileCalendarOpen] = React.useState(false);

  const [entryLoaded, setEntryLoaded] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [editorText, setEditorText] = React.useState("");
  const [confirmedText, setConfirmedText] = React.useState("");
  const [savedAt, setSavedAt] = React.useState<string | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [conflictCurrent, setConflictCurrent] = React.useState<MyDayEntry | null>(null);
  const [storageAvailable, setStorageAvailable] = React.useState(true);
  const [restoredFromDraft, setRestoredFromDraft] = React.useState(false);
  const [sessionChanged, setSessionChanged] = React.useState(false);
  const sessionChangedRef = React.useRef(false);
  const onSessionChangedRef = React.useRef(onSessionChanged);
  onSessionChangedRef.current = onSessionChanged;

  // Synchronous refs for the sequential save loop & stale-response guards
  const mountedRef = React.useRef(true);
  const activeActorRef = React.useRef(actorId);
  activeActorRef.current = actorId;
  const activeDateRef = React.useRef(selectedDate);
  activeDateRef.current = selectedDate;
  const dayEpochRef = React.useRef(0);
  const loadRequestSeqRef = React.useRef(0);

  const entryLoadedRef = React.useRef(false);
  const editorTextRef = React.useRef("");
  const confirmedTextRef = React.useRef("");
  const confirmedVersionRef = React.useRef(0);
  const draftBaseVersionRef = React.useRef<number | null>(null);
  const conflictCurrentRef = React.useRef<MyDayEntry | null>(null);
  const pendingIntentRef = React.useRef<PendingSaveIntent | null>(null);

  const debounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightLoopRef = React.useRef<Promise<boolean> | null>(null);
  const runNextAfterInFlightRef = React.useRef(false);
  const prevUrlDateParamRef = React.useRef<string | null>(urlDateParam);

  const clearDebounceTimer = React.useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const handleSessionChanged = React.useCallback(() => {
    if (sessionChangedRef.current) return;
    // Invalidate every outstanding response/queued intent before refreshing the
    // provider. No old text or version can become a new account's draft.
    sessionChangedRef.current = true;
    dayEpochRef.current += 1;
    loadRequestSeqRef.current += 1;
    clearDebounceTimer();
    pendingIntentRef.current = null;
    runNextAfterInFlightRef.current = false;
    draftBaseVersionRef.current = null;
    conflictCurrentRef.current = null;
    entryLoadedRef.current = false;
    editorTextRef.current = "";
    confirmedTextRef.current = "";
    confirmedVersionRef.current = 0;
    clearAllMyDayDrafts();
    setSessionChanged(true);
    setEntryLoaded(false);
    setEditorText("");
    setConfirmedText("");
    setSavedAt(null);
    setConflictCurrent(null);
    setLoadError(null);
    setSaveError(null);
    setIsLoading(false);
    setIsSaving(false);
    setRestoredFromDraft(false);
    setMobileCalendarOpen(false);
    try {
      void Promise.resolve(onSessionChangedRef.current?.()).catch(() => {
        // Stay hidden and terminal if the provider refresh fails.
      });
    } catch { /* A synchronous refresh failure cannot revive the old editor. */ }
  }, [clearDebounceTimer]);

  const syncDateToUrl = React.useCallback(
    (nextDate: string) => {
      prevUrlDateParamRef.current = nextDate;
      try {
        router?.replace?.(`${pathname}?date=${encodeURIComponent(nextDate)}`, {
          scroll: false,
        });
      } catch {
        // Ignore router errors in isolated test harnesses.
      }
    },
    [pathname, router],
  );

  // Sync URL on initial mount if `?date=` was missing or invalid
  React.useEffect(() => {
    if (!isDayKey(urlDateParam) || urlDateParam !== selectedDate) {
      syncDateToUrl(selectedDate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update `today` on window focus, visibilitychange, and Moscow midnight
  const refreshTodayMoscow = React.useCallback(() => {
    const currentMsk = todayMoscow();
    if (isDayKey(currentMsk) && currentMsk !== todayRef.current) {
      todayRef.current = currentMsk;
      setToday(currentMsk);
    }
  }, []);

  React.useEffect(() => {
    const onFocus = () => refreshTodayMoscow();
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshTodayMoscow();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    let midnightTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleMidnight = () => {
      const delay = msUntilNextMoscowMidnight();
      midnightTimer = setTimeout(() => {
        refreshTodayMoscow();
        scheduleMidnight();
      }, delay);
    };
    scheduleMidnight();

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      if (midnightTimer !== null) clearTimeout(midnightTimer);
    };
  }, [refreshTodayMoscow]);

  /**
   * Sequential single-flight PUT runner.
   * Only one PUT request is in flight at a time. If new text was queued while
   * the request was in flight (and debounce elapsed or flush was requested),
   * the runner immediately executes the follow-up PUT with the updated version.
   */
  const runSequentialSave = React.useCallback(
    async (forceImmediateFollowUp = false): Promise<boolean> => {
      if (forceImmediateFollowUp) {
        runNextAfterInFlightRef.current = true;
      }
      if (inFlightLoopRef.current) {
        return inFlightLoopRef.current;
      }

      const loopPromise = (async (): Promise<boolean> => {
        const startEpoch = dayEpochRef.current;
        const startActor = activeActorRef.current;
        const startDate = activeDateRef.current;

        while (true) {
          if (
            !mountedRef.current ||
            sessionChangedRef.current ||
            dayEpochRef.current !== startEpoch ||
            activeActorRef.current !== startActor ||
            activeDateRef.current !== startDate ||
            !entryLoadedRef.current
          ) {
            return false;
          }

          if (conflictCurrentRef.current !== null) {
            return false;
          }

          const targetText = editorTextRef.current;
          const existingIntent = pendingIntentRef.current;
          const unsettledIntent =
            existingIntent?.actorId === startActor && existingIntent.date === startDate
              ? existingIntent
              : null;
          // A failed response does not prove the previous write failed. Settle
          // that exact operation before comparing or saving the latest input.
          if (!unsettledIntent && targetText === confirmedTextRef.current) {
            runNextAfterInFlightRef.current = false;
            return true;
          }

          const expectedVersion =
            draftBaseVersionRef.current ?? confirmedVersionRef.current;

          const intent: PendingSaveIntent =
            unsettledIntent ?? {
              actorId: startActor,
              date: startDate,
              text: targetText,
              expectedVersion,
              operationId: createMyDayOperationId(),
            };

          pendingIntentRef.current = intent;
          runNextAfterInFlightRef.current = false;

          setIsSaving(true);
          setSaveError(null);

          try {
            const response = await apiFetch<MyDayEntry>(
              `/api/my-day?date=${encodeURIComponent(startDate)}`,
              {
                method: "PUT",
                headers: { "Content-Type": "application/json", [MY_DAY_ACTOR_HEADER]: intent.actorId },
                body: JSON.stringify({
                  text: intent.text,
                  expectedVersion: intent.expectedVersion,
                  operationId: intent.operationId,
                }),
              },
            );

            if (
              !mountedRef.current ||
              dayEpochRef.current !== startEpoch ||
              activeActorRef.current !== startActor ||
              activeDateRef.current !== startDate
            ) {
              return false;
            }

            if (isDayKey(response.today) && response.today !== todayRef.current) {
              todayRef.current = response.today;
              setToday(response.today);
            }

            confirmedTextRef.current = response.text;
            confirmedVersionRef.current = response.version;
            draftBaseVersionRef.current = null;
            pendingIntentRef.current = null;

            setConfirmedText(response.text);
            setSavedAt(response.updatedAt);
            setSaveError(null);
            setConflictCurrent(null);
            conflictCurrentRef.current = null;

            const settleResult = settleMyDayDraftOnConfirm({
              actorId: startActor,
              date: startDate,
              confirmedText: response.text,
              confirmedVersion: response.version,
              currentEditorText: editorTextRef.current,
            });
            setStorageAvailable(settleResult.storageAvailable);
            if (editorTextRef.current === response.text) {
              setRestoredFromDraft(false);
            }

            // If user typed more while PUT was in flight AND either debounce fired
            // or flush requested immediate completion, continue loop immediately.
            if (
              editorTextRef.current !== confirmedTextRef.current &&
              (runNextAfterInFlightRef.current || forceImmediateFollowUp)
            ) {
              continue;
            }

            return editorTextRef.current === confirmedTextRef.current;
          } catch (error) {
            if (
              !mountedRef.current ||
              dayEpochRef.current !== startEpoch ||
              activeActorRef.current !== startActor ||
              activeDateRef.current !== startDate
            ) {
              return false;
            }

            if (isSessionChanged(error)) {
              handleSessionChanged();
              return false;
            }

            const conflictEntry = extractConflictCurrent(error);
            if (conflictEntry) {
              if (isDayKey(conflictEntry.today) && conflictEntry.today !== todayRef.current) {
                todayRef.current = conflictEntry.today;
                setToday(conflictEntry.today);
              }
              confirmedTextRef.current = conflictEntry.text;
              confirmedVersionRef.current = conflictEntry.version;
              // Retain the rejected base until the employee chooses a version.
              // Advancing it here would authorize a silent overwrite on reload.
              draftBaseVersionRef.current = intent.expectedVersion;
              pendingIntentRef.current = null;
              conflictCurrentRef.current = conflictEntry;

              setConfirmedText(conflictEntry.text);
              setSavedAt(conflictEntry.updatedAt);
              setConflictCurrent(conflictEntry);
              setSaveError(null);

              const draftRes = writeMyDayDraft({
                actorId: startActor,
                date: startDate,
                text: editorTextRef.current,
                baseVersion: intent.expectedVersion,
              });
              setStorageAvailable(draftRes.storageAvailable);
              return false;
            }

            // Non-409 failure: keep `pendingIntentRef.current` intact so retry reuses the exact same operationId!
            setSaveError(
              extractErrorMessage(
                error,
                "Не удалось сохранить изменения. Проверьте соединение и повторите попытку.",
              ),
            );
            return false;
          } finally {
            if (
              mountedRef.current &&
              dayEpochRef.current === startEpoch &&
              activeActorRef.current === startActor &&
              activeDateRef.current === startDate
            ) {
              setIsSaving(false);
            }
          }
        }
      })();

      inFlightLoopRef.current = loopPromise;
      try {
        return await loopPromise;
      } finally {
        if (inFlightLoopRef.current === loopPromise) {
          inFlightLoopRef.current = null;
        }
      }
    },
    [handleSessionChanged],
  );

  const scheduleDebouncedSave = React.useCallback(() => {
    clearDebounceTimer();
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      if (!mountedRef.current || sessionChangedRef.current || !entryLoadedRef.current) return;
      if (conflictCurrentRef.current !== null) return;
      if (editorTextRef.current === confirmedTextRef.current && !pendingIntentRef.current) return;
      void runSequentialSave(true);
    }, MY_DAY_AUTOSAVE_DELAY_MS);
  }, [clearDebounceTimer, runSequentialSave]);

  /**
   * Load the entry for `(actorId, date)` from GET /api/my-day?date=YYYY-MM-DD.
   */
  const loadDayEntry = React.useCallback(
    async (targetDate: string) => {
      if (sessionChangedRef.current) return;
      clearDebounceTimer();
      const requestSeq = ++loadRequestSeqRef.current;
      const requestActor = activeActorRef.current;
      const requestEpoch = dayEpochRef.current;

      entryLoadedRef.current = false;
      setEntryLoaded(false);
      setIsLoading(true);
      setLoadError(null);
      setSaveError(null);
      setConflictCurrent(null);
      conflictCurrentRef.current = null;

      try {
        const entry = await apiFetch<MyDayEntry>(
          `/api/my-day?date=${encodeURIComponent(targetDate)}`,
          { headers: { [MY_DAY_ACTOR_HEADER]: requestActor } },
        );

        if (
          !mountedRef.current ||
          loadRequestSeqRef.current !== requestSeq ||
          dayEpochRef.current !== requestEpoch ||
          activeActorRef.current !== requestActor ||
          activeDateRef.current !== targetDate
        ) {
          return;
        }

        if (isDayKey(entry.today) && entry.today !== todayRef.current) {
          todayRef.current = entry.today;
          setToday(entry.today);
        }

        confirmedTextRef.current = entry.text;
        confirmedVersionRef.current = entry.version;
        setConfirmedText(entry.text);
        setSavedAt(entry.updatedAt);

        const draftRead = readMyDayDraft(requestActor, targetDate);
        setStorageAvailable(draftRead.storageAvailable);

        const draft = draftRead.value;
        if (draft && draft.text !== entry.text) {
          editorTextRef.current = draft.text;
          draftBaseVersionRef.current = draft.baseVersion;
          setEditorText(draft.text);
          setRestoredFromDraft(true);
          entryLoadedRef.current = true;
          setEntryLoaded(true);
          setIsLoading(false);
          if (draft.baseVersion !== entry.version) {
            // A stale draft (including an unresolved pre-reload conflict) needs
            // explicit choice; recovery must never rebase it automatically.
            conflictCurrentRef.current = entry;
            setConflictCurrent(entry);
          } else {
            scheduleDebouncedSave();
          }
          return;
        }

        if (draft && draft.text === entry.text) {
          const cleanRes = removeMyDayDraft(requestActor, targetDate);
          setStorageAvailable(cleanRes.storageAvailable);
        }

        editorTextRef.current = entry.text;
        draftBaseVersionRef.current = null;
        pendingIntentRef.current = null;
        setEditorText(entry.text);
        setRestoredFromDraft(false);
        entryLoadedRef.current = true;
        setEntryLoaded(true);
        setIsLoading(false);
      } catch (error) {
        if (
          !mountedRef.current ||
          loadRequestSeqRef.current !== requestSeq ||
          dayEpochRef.current !== requestEpoch ||
          activeActorRef.current !== requestActor ||
          activeDateRef.current !== targetDate
        ) {
          return;
        }

        if (isSessionChanged(error)) {
          handleSessionChanged();
          return;
        }

        entryLoadedRef.current = false;
        setEntryLoaded(false);
        setIsLoading(false);
        setLoadError(
          extractErrorMessage(
            error,
            "Не удалось загрузить запись за выбранный день. Повторите попытку.",
          ),
        );
      }
    },
    [clearDebounceTimer, handleSessionChanged, scheduleDebouncedSave],
  );

  // Initial load on mount
  React.useEffect(() => {
    mountedRef.current = true;
    void loadDayEntry(selectedDate);
    return () => {
      mountedRef.current = false;
      clearDebounceTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Flush any pending edits before switching to `nextDate`.
   * On error or 409 conflict, stay on the current date and preserve the text.
   */
  const handleSelectDate = React.useCallback(
    async (nextDate: string) => {
      if (sessionChangedRef.current) return;
      if (!isDayKey(nextDate)) return;
      if (nextDate > todayRef.current) return;
      if (nextDate === activeDateRef.current) {
        setMobileCalendarOpen(false);
        return;
      }
      if (isLoading || !entryLoadedRef.current) return;
      if (conflictCurrentRef.current !== null) return;

      clearDebounceTimer();

      if (inFlightLoopRef.current || pendingIntentRef.current || editorTextRef.current !== confirmedTextRef.current) {
        const flushed = await runSequentialSave(true);
        if (!flushed) {
          return;
        }
      }

      if (!mountedRef.current) return;

      // Advance epoch and switch to the new day
      dayEpochRef.current += 1;
      activeDateRef.current = nextDate;
      pendingIntentRef.current = null;
      draftBaseVersionRef.current = null;
      conflictCurrentRef.current = null;
      entryLoadedRef.current = false;

      setSelectedDate(nextDate);
      setCalendarMonth(dayKeyToCalendarDate(nextDate));
      setMobileCalendarOpen(false);
      setEntryLoaded(false);
      setIsLoading(true);
      setLoadError(null);
      setSaveError(null);
      setConflictCurrent(null);
      setRestoredFromDraft(false);

      syncDateToUrl(nextDate);
      await loadDayEntry(nextDate);
    },
    [clearDebounceTimer, isLoading, loadDayEntry, runSequentialSave, syncDateToUrl],
  );

  // React to external URL `?date=` changes (e.g. browser Back/Forward)
  const lastSeenUrlParamRef = React.useRef<string | null>(urlDateParam);
  React.useEffect(() => {
    if (urlDateParam === lastSeenUrlParamRef.current) return;
    lastSeenUrlParamRef.current = urlDateParam;
    if (!isDayKey(urlDateParam)) return;
    if (urlDateParam === prevUrlDateParamRef.current) return;
    prevUrlDateParamRef.current = urlDateParam;
    if (urlDateParam !== activeDateRef.current && urlDateParam <= todayRef.current) {
      void handleSelectDate(urlDateParam);
    }
  }, [handleSelectDate, urlDateParam]);

  const handleTextChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (sessionChangedRef.current || !entryLoadedRef.current || isLoading) return;
    const rawValue = event.target.value;
    const nextText =
      rawValue.length > MY_DAY_MAX_LENGTH
        ? rawValue.slice(0, MY_DAY_MAX_LENGTH)
        : rawValue;

    editorTextRef.current = nextText;
    setEditorText(nextText);
    setSaveError(null);

    const currentActor = activeActorRef.current;
    const currentDate = activeDateRef.current;

    if (
      nextText === confirmedTextRef.current &&
      !inFlightLoopRef.current &&
      !pendingIntentRef.current &&
      conflictCurrentRef.current === null
    ) {
      pendingIntentRef.current = null;
      draftBaseVersionRef.current = null;
      clearDebounceTimer();
      const removeRes = removeMyDayDraft(currentActor, currentDate);
      setStorageAvailable(removeRes.storageAvailable);
      setRestoredFromDraft(false);
      return;
    }

    const baseVersion =
      draftBaseVersionRef.current ?? confirmedVersionRef.current;
    const writeRes = writeMyDayDraft({
      actorId: currentActor,
      date: currentDate,
      text: nextText,
      baseVersion,
    });
    setStorageAvailable(writeRes.storageAvailable);

    if (conflictCurrentRef.current === null) {
      scheduleDebouncedSave();
    }
  };

  const handleRetrySave = async () => {
    if (!entryLoadedRef.current || isLoading) return;
    clearDebounceTimer();
    await runSequentialSave(true);
  };

  const handleKeepMyVersion = async () => {
    const conflict = conflictCurrentRef.current;
    if (!conflict) return;
    clearDebounceTimer();

    confirmedTextRef.current = conflict.text;
    confirmedVersionRef.current = conflict.version;
    draftBaseVersionRef.current = conflict.version;
    pendingIntentRef.current = null;
    conflictCurrentRef.current = null;
    setConflictCurrent(null);
    setSaveError(null);

    const writeRes = writeMyDayDraft({
      actorId: activeActorRef.current,
      date: activeDateRef.current,
      text: editorTextRef.current,
      baseVersion: conflict.version,
    });
    setStorageAvailable(writeRes.storageAvailable);

    if (editorTextRef.current === conflict.text) {
      const cleanRes = removeMyDayDraft(activeActorRef.current, activeDateRef.current);
      setStorageAvailable(cleanRes.storageAvailable);
      setRestoredFromDraft(false);
      return;
    }

    await runSequentialSave(true);
  };

  const handleAcceptServerVersion = () => {
    const conflict = conflictCurrentRef.current;
    if (!conflict) return;
    clearDebounceTimer();

    confirmedTextRef.current = conflict.text;
    confirmedVersionRef.current = conflict.version;
    editorTextRef.current = conflict.text;
    draftBaseVersionRef.current = null;
    pendingIntentRef.current = null;
    conflictCurrentRef.current = null;

    setConfirmedText(conflict.text);
    setSavedAt(conflict.updatedAt);
    setEditorText(conflict.text);
    setConflictCurrent(null);
    setSaveError(null);
    setRestoredFromDraft(false);

    const cleanRes = removeMyDayDraft(activeActorRef.current, activeDateRef.current);
    setStorageAvailable(cleanRes.storageAvailable);
  };

  const isDirty =
    entryLoaded &&
    (editorText !== confirmedText ||
      pendingIntentRef.current !== null ||
      isSaving ||
      saveError !== null ||
      conflictCurrent !== null);

  // Warn before closing/reloading tab when there are unsaved changes
  React.useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isDirty]);

  const previousDayKey = shiftDayKey(selectedDate, -1);
  const nextDayKey = shiftDayKey(selectedDate, 1);
  const isTodaySelected = selectedDate === today;
  const isNextDayDisabled =
    nextDayKey > today || isLoading || !entryLoaded || conflictCurrent !== null;
  const isDateSwitchDisabled =
    isLoading || !entryLoaded || conflictCurrent !== null;

  const formattedHeading = formatMyDayHeading(selectedDate);
  const savedTime = savedAt && Number.isFinite(Date.parse(savedAt))
    ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" }).format(new Date(savedAt))
    : null;
  const calendar = <MyDayCalendar date={selectedDate} today={today} month={calendarMonth}
    onMonthChange={setCalendarMonth} onSelect={date => void handleSelectDate(date)} />;

  if (sessionChanged) {
    return <section role="alert" className="m-6 space-y-3 rounded-xl border bg-card p-6 text-card-foreground">
      <h1 className="text-xl font-semibold">Учётная запись изменилась</h1>
      <p className="text-[18px] leading-relaxed">Обновите страницу, чтобы открыть дневник текущего пользователя.</p>
      <Button type="button" variant="outline" className="min-h-11" onClick={() => window.location.reload()}>
        Обновить страницу
      </Button>
    </section>;
  }

  return (
    <div className="container mx-auto min-w-0 max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
      <header className="mb-6 space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Мой день
        </h1>
        <p className="text-sm text-muted-foreground sm:text-base">
          Записывайте, что сделали за день. Текст сохраняется автоматически.
        </p>
      </header>

      <div className="grid grid-cols-1 items-stretch gap-4 lg:min-h-[calc(100dvh-224px)] lg:grid-cols-[minmax(0,1fr)_408px]">
        {/* Left column: Editor card */}
        <section
          aria-label="Запись за день"
          className="flex min-w-0 flex-col rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-6"
        >
          {/* Date navigation buttons */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={isDateSwitchDisabled}
              onClick={() => void handleSelectDate(previousDayKey)}
              className="min-h-11 flex-1 text-base sm:flex-initial"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Предыдущий день</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              disabled={isTodaySelected || isDateSwitchDisabled}
              onClick={() => void handleSelectDate(today)}
              className="min-h-11 text-base"
            >
              Сегодня
            </Button>

            <Button
              type="button"
              variant="outline"
              disabled={isNextDayDisabled}
              onClick={() => void handleSelectDate(nextDayKey)}
              className="min-h-11 flex-1 text-base sm:flex-initial"
            >
              <span>Следующий день</span>
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>

          {/* Selected date heading + mobile calendar trigger button */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-bold tracking-tight text-foreground sm:text-3xl">
              {formattedHeading}
            </h2>

            <Popover open={mobileCalendarOpen} onOpenChange={setMobileCalendarOpen}>
            <PopoverTrigger asChild><Button
              type="button"
              variant="outline"
              aria-label={`Выбрать дату: ${formattedHeading}`}
              className="min-h-11 w-full lg:hidden"
            >
              <CalendarIcon className="h-4 w-4" aria-hidden="true" />
              <span>Выбрать дату</span>
            </Button></PopoverTrigger>
            <PopoverContent align="start" aria-label="Календарь выбора дня"
              className="max-h-[var(--radix-popover-content-available-height)] w-[calc(100vw-8px)] max-w-[360px] overflow-y-auto p-0 lg:hidden">
              {calendar}
            </PopoverContent>
            </Popover>
          </div>

          {/* Storage unavailability notice */}
          {!storageAvailable && (
            <div
              role="status"
              className="mt-4 flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-3 text-sm text-foreground"
            >
              <AlertCircle
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              <span>
                Локальное хранилище браузера недоступно. Ввод и сохранение на сервер работают, но несохранённый черновик не восстановится после перезагрузки страницы.
              </span>
            </div>
          )}

          {/* Initial GET load error */}
          {loadError && (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{loadError}</span>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadDayEntry(selectedDate)}
                className="min-h-11 shrink-0"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Повторить загрузку
              </Button>
            </div>
          )}

          {/* Save error with retry */}
          {saveError && !conflictCurrent && (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{saveError}</span>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={isSaving}
                onClick={() => void handleRetrySave()}
                className="min-h-11 shrink-0"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Повторить
              </Button>
            </div>
          )}

          {/* 409 Conflict resolution panel showing both versions and explicit choice */}
          {conflictCurrent && (
            <div
              role="alert"
              aria-label="Конфликт версий дневника"
              className="mt-4 space-y-4 rounded-xl border border-amber-500/50 bg-amber-500/10 p-4 text-foreground"
            >
              <div className="space-y-1">
                <p className="font-semibold">
                  Дневник был изменён в другом окне или сессии
                </p>
                <p className="text-sm text-muted-foreground">
                  Сравните обе версии и выберите, какой вариант нужно оставить:
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="rounded-lg border bg-card p-3">
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Ваш черновик
                  </div>
                  <pre
                    data-testid="my-day-conflict-local"
                    className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-sans text-sm"
                  >
                    {editorText || "— Пустая запись —"}
                  </pre>
                </div>

                <div className="rounded-lg border bg-card p-3">
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Версия на сервере
                  </div>
                  <pre
                    data-testid="my-day-conflict-server"
                    className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-sans text-sm"
                  >
                    {conflictCurrent.text || "— Пустая запись —"}
                  </pre>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  disabled={isSaving}
                  onClick={() => void handleKeepMyVersion()}
                  className="min-h-11"
                >
                  Сохранить мой вариант
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isSaving}
                  onClick={handleAcceptServerVersion}
                  className="min-h-11"
                >
                  Принять версию с сервера
                </Button>
              </div>
            </div>
          )}

          {/* Editor container */}
          <div className="mt-5 flex flex-1 flex-col overflow-hidden rounded-xl border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-card px-4 py-3">
              <label
                htmlFor="my-day-editor"
                className="text-sm font-semibold text-foreground sm:text-base"
              >
                Что я сделал за день
              </label>

              <div
                role="status"
                aria-live="polite"
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground sm:text-sm"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
                    <span>Загрузка записи…</span>
                  </>
                ) : !entryLoaded ? (
                  <>
                    <AlertCircle className="h-4 w-4 text-destructive" aria-hidden="true" />
                    <span>Запись не загружена</span>
                  </>
                ) : isSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
                    <span>Сохранение…</span>
                  </>
                ) : conflictCurrent ? (
                  <>
                    <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                    <span>Выберите версию для сохранения</span>
                  </>
                ) : saveError ? (
                  <>
                    <AlertCircle className="h-4 w-4 text-destructive" aria-hidden="true" />
                    <span>Ошибка сохранения</span>
                  </>
                 ) : editorText !== confirmedText || pendingIntentRef.current !== null ? (
                  <span>Несохранённые изменения…</span>
                ) : (
                  <>
                    <CheckCircle2
                      className="h-4 w-4 text-emerald-600 dark:text-emerald-400"
                      aria-hidden="true"
                    />
                    <span>{savedTime ? `Сохранено в ${savedTime}` : "Все изменения сохранены"}</span>
                  </>
                )}
              </div>
            </div>

            <Textarea
              id="my-day-editor"
              value={editorText}
              onChange={handleTextChange}
              disabled={!entryLoaded || isLoading}
              aria-busy={isLoading || isSaving}
              maxLength={MY_DAY_MAX_LENGTH}
              rows={14}
              placeholder="Опишите выполненные за день задачи и важные итоги…"
              className="min-h-[360px] w-full flex-1 resize-y rounded-none border-0 bg-card px-4 py-3.5 text-[18px] leading-relaxed shadow-none focus-visible:ring-2 focus-visible:ring-inset md:text-[18px]"
            />

            {restoredFromDraft && editorText !== confirmedText && <p role="status" className="border-t px-4 py-2 text-sm text-muted-foreground">Восстановлен несохранённый черновик.</p>}
          </div>
        </section>

        {/* Right column: Calendar card (always visible on desktop, toggled by date button on mobile) */}
        <aside
          id="my-day-desktop-calendar"
          aria-label="Календарь выбора дня"
          className="hidden w-full rounded-xl border bg-card p-4 text-card-foreground shadow-xs lg:block"
        >
          {calendar}

          <p className="mt-4 text-sm text-muted-foreground">
            Прошлые дни можно дополнять и исправлять.
          </p>
        </aside>
      </div>
    </div>
  );
}
