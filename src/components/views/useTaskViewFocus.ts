"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

// The routed task panel unmounts on close. Keep focus with its still-mounted view.
export function useTaskViewFocus<T>(
  onTaskClick: (task: T) => void,
  containerRef?: RefObject<HTMLElement | null>,
) {
  const fallbackRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!containerRef) return;
    let focused: HTMLElement | null = null;
    let neighbours: HTMLElement[] = [];
    const remember = (target: HTMLElement) => {
      const container = containerRef.current;
      const row = target.closest("tr");
      if (!container?.contains(target) || !row) return;
      const openers = Array.from(container.querySelectorAll<HTMLElement>("[data-task-opener]"));
      const index = openers.findIndex(opener => row.contains(opener));
      if (index < 0) return;
      focused = target;
      // Preserve the visible order before removal, preferring the next row.
      neighbours = [...openers.slice(index + 1), ...openers.slice(0, index).reverse()];
    };
    const restore = () => {
      const container = containerRef.current;
      if (!container?.isConnected) return;
      const target = neighbours.find(node => node.isConnected && container.contains(node));
      (target ?? container).focus();
    };
    fallbackRef.current = restore;
    const onFocus = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      if (containerRef.current?.contains(event.target)) {
        focused = null;
        remember(event.target);
      } else if (!event.target.closest('aside[role="dialog"][aria-label="Детали задачи"]')) {
        focused = null;
      }
    };
    const observer = new MutationObserver(() => {
      if (!focused) return;
      if (focused.isConnected) {
        remember(focused);
      } else if (document.activeElement === document.body &&
          !document.querySelector('[role="dialog"][aria-modal="true"]')) {
        focused = null;
        restore();
      }
    });
    document.addEventListener("focusin", onFocus);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", onFocus);
      fallbackRef.current = () => undefined;
    };
  }, [containerRef]);
  const callbackRef = useRef(onTaskClick);
  useEffect(() => { callbackRef.current = onTaskClick; }, [onTaskClick]);
  const stopRef = useRef<() => void>(() => undefined);
  useEffect(() => () => stopRef.current(), []);

  return useCallback((task: T, opener: HTMLElement) => {
    stopRef.current();
    opener.focus();
    let panel: Element | null = null;
    const observer = new MutationObserver(() => {
      if (!panel) {
        panel = document.querySelector('aside[role="dialog"][aria-label="Детали задачи"]');
        return;
      }
      if (panel.isConnected) return;
      stop();
      const active = document.activeElement;
      if ((!active || active === document.body) &&
          !document.querySelector('[role="dialog"][aria-modal="true"]')) {
        if (opener.isConnected) opener.focus();
        else fallbackRef.current();
      }
    });
    const stop = () => {
      observer.disconnect();
      if (stopRef.current === stop) stopRef.current = () => undefined;
    };
    stopRef.current = stop;
    observer.observe(document.body, { childList: true, subtree: true });
    try { callbackRef.current(task); }
    catch (error) { stop(); throw error; }
  }, []);
}
