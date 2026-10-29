"use client";

import { useCallback, useEffect, useState } from "react";

type DraftState = { key: string | null; text: string; ready: boolean; error: boolean };

// Text only, local to this browser. The versioned tuple avoids collisions
// between accounts/tasks and keeps this separate from the message retry queue.
export function useChatDraft(userId: string | undefined, taskId: string) {
  const key = userId ? `lenkanban:chat-draft:v1:${JSON.stringify([userId, taskId])}` : null;
  const [state, setState] = useState<DraftState>({ key: null, text: "", ready: false, error: false });

  useEffect(() => {
    if (!key) {
      setState({ key: null, text: "", ready: false, error: false });
      return;
    }
    try {
      const text = window.localStorage.getItem(key) ?? "";
      if (text.length > 20_000) throw new Error("Draft exceeds message limit");
      setState({ key, text, ready: true, error: false });
    } catch {
      // Storage may be blocked or full. Editing must still work in memory.
      setState({ key, text: "", ready: true, error: true });
    }
  }, [key]);

  const setDraft = useCallback((text: string) => {
    if (!key) return;
    let error = false;
    try {
      // Persist at the input boundary: no delayed write to lose on navigation,
      // and no mount effect that could overwrite a different task's draft.
      if (text) window.localStorage.setItem(key, text);
      else window.localStorage.removeItem(key);
    } catch {
      error = true;
    }
    setState({ key, text, ready: true, error });
  }, [key]);

  const current = state.key === key;
  return {
    draft: current ? state.text : "",
    ready: Boolean(key && current && state.ready),
    error: current && state.error,
    setDraft,
  };
}
