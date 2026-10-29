"use client";

import * as React from "react";

type AdminListFocusOptions = {
  listRef: React.RefObject<HTMLDivElement | null>;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
};

type PendingLoad = {
  startedFromButton: boolean;
  rowCount: number;
};

/**
 * Keeps keyboard focus predictable around the "load more" control of the
 * administrator lists.
 *
 * The control stays focusable while the next page is pending (it is exposed
 * with `aria-disabled`/`aria-busy` instead of the native `disabled`
 * attribute), so focus never falls back to `document.body` mid-request.
 * Once the request settles:
 * - another page exists -> focus returns to the "load more" button;
 * - the last page was loaded -> the control is exhausted, so focus moves to
 *   the first row of the freshly loaded page, with the list as a fallback.
 */
export function useAdminListFocus({ listRef, buttonRef }: AdminListFocusOptions) {
  const pending = React.useRef<PendingLoad | null>(null);

  const beginLoadMore = React.useCallback((rowCount: number) => {
    pending.current = {
      startedFromButton: document.activeElement === buttonRef.current,
      rowCount,
    };
  }, [buttonRef]);

  const finishLoadMore = React.useCallback((hasNextPage: boolean) => {
    const state = pending.current;
    pending.current = null;
    if (!state?.startedFromButton) return;
    // Defer until React has committed the new rows and the new button state.
    setTimeout(() => {
      const button = buttonRef.current;
      if (hasNextPage && button && !button.disabled) {
        button.focus();
        if (document.activeElement === button) return;
      }
      const container = listRef.current;
      if (!container) return;
      const firstNewRow = container.querySelectorAll<HTMLElement>("[data-admin-row]")[state.rowCount];
      if (firstNewRow) {
        firstNewRow.focus();
        if (document.activeElement === firstNewRow) return;
      }
      container.focus();
    }, 0);
  }, [buttonRef, listRef]);

  return { beginLoadMore, finishLoadMore };
}
