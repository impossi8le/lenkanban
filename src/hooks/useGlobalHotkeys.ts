"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { parseProjectContext, projectCreateTaskHref, projectViewHref } from "@/lib/project-navigation";

interface UseGlobalHotkeysOptions {
  onToggleSidebar?: () => void;
  onOpenCommandPalette?: () => void;
}

// Every app-wide shortcut uses the same editor, composition and modal guard.
export function shouldIgnoreGlobalHotkey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return true;
  if (document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return true;
  return [...event.composedPath(), document.activeElement].some(target => target instanceof HTMLElement && (
    target.isContentEditable || target.closest('input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])')
  ));
}

// Shortcuts are physical keys: `event.key` changes with the keyboard layout
// (Russian "т" is the KeyN key, "." is Slash), while `event.code` does not.
// `event.key` stays as a fallback for synthetic/assistive events without a code.
function matchesShortcut(event: KeyboardEvent, key: string, code: string): boolean {
  return event.key.toLowerCase() === key || event.code === code;
}

function isSlashShortcut(event: KeyboardEvent): boolean {
  return matchesShortcut(event, "/", "Slash") || event.code === "NumpadDivide";
}

export function useGlobalHotkeys({ onToggleSidebar, onOpenCommandPalette }: UseGlobalHotkeysOptions = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const slash = isSlashShortcut(event);
      if (shouldIgnoreGlobalHotkey(event) || event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && !slash)) return;
      const context = parseProjectContext(pathname);
      let action: (() => void) | undefined;
      if (matchesShortcut(event, "b", "KeyB")) action = onToggleSidebar;
      if (slash) action = onOpenCommandPalette;
      if (context) {
        if (matchesShortcut(event, "n", "KeyN")) action = () => router.push(projectCreateTaskHref(context.projectId, searchParams));
        const view = matchesShortcut(event, "1", "Digit1") ? "board"
          : matchesShortcut(event, "2", "Digit2") ? "table"
          : matchesShortcut(event, "3", "Digit3") ? "calendar"
          : null;
        if (view) action = () => router.push(projectViewHref(context.projectId, view, searchParams));
      }
      if (action) { event.preventDefault(); action(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onToggleSidebar, onOpenCommandPalette, pathname, router, searchParams]);
}
