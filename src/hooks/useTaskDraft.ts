"use client";

import { useCallback, useEffect, useState } from "react";

type Fields = { title?: string; description?: string };
type Field = keyof Fields;

function read(key: string): Fields {
  const value = JSON.parse(window.localStorage.getItem(key) ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid draft");
  const result: Fields = {};
  for (const field of ["title", "description"] as const) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== "string" || value[field].length > 100_000) throw new Error("Invalid draft field");
      result[field] = value[field];
    }
  }
  return result;
}

function write(key: string, fields: Fields) {
  if (Object.keys(fields).length) window.localStorage.setItem(key, JSON.stringify(fields));
  else window.localStorage.removeItem(key);
}

// Only input events write drafts. Server snapshots never replace local text.
export function useTaskDraft(userId: string | undefined, taskId: string | undefined) {
  const key = userId && taskId ? `lenkanban:task-draft:v1:${JSON.stringify([userId, taskId])}` : null;
  const [state, setState] = useState<{ key: string | null; ready: boolean; recovery: Fields | null; error: boolean }>({ key: null, ready: false, recovery: null, error: false });
  useEffect(() => {
    if (!key) return;
    try {
      const fields = read(key);
      setState({ key, ready: true, recovery: Object.keys(fields).length ? fields : null, error: false });
    } catch {
      setState({ key, ready: true, recovery: null, error: true });
    }
  }, [key]);

  const change = useCallback((field: Field, text: string) => {
    if (!key) return;
    try {
      write(key, { ...read(key), [field]: text });
      setState(s => s.key === key ? { ...s, error: false } : s);
    } catch { setState(s => s.key === key ? { ...s, error: true } : s); }
  }, [key]);

  const acknowledge = useCallback((field: Field, submitted: string) => {
    if (!key) return;
    try {
      const fields = read(key);
      // An older response must not delete text typed while the request ran.
      if (fields[field] === submitted) { delete fields[field]; write(key, fields); }
    } catch { setState(s => s.key === key ? { ...s, error: true } : s); }
  }, [key]);

  const dismiss = (discard: boolean) => {
    if (!key) return;
    try {
      if (discard) {
        const fields = read(key);
        for (const field of ["title", "description"] as const) {
          if (fields[field] === state.recovery?.[field]) delete fields[field];
        }
        write(key, fields);
      }
      setState(s => ({ ...s, recovery: null }));
    } catch { setState(s => ({ ...s, error: true })); }
  };
  const current = key !== null && state.key === key;
  return { ready: current && state.ready, recovery: current ? state.recovery : null, error: current && state.error, change, acknowledge, dismiss };
}
