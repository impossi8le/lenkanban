"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Search, Loader2 } from "lucide-react";
import { shouldIgnoreGlobalHotkey } from "@/hooks/useGlobalHotkeys";

interface CommandPaletteProps {
  projects?: Array<{ id: string; name: string }>;
  onCreateTask?: () => void;
}

// cmdk, the dialog primitives and the search surface load on the first open
// (Ctrl/⌘+K, slash or a click), not with the shell of every page.
const CommandPaletteDialog = dynamic(
  () => import("./command-palette-dialog").then((mod) => ({ default: mod.CommandPaletteDialog })),
  {
    ssr: false,
    loading: () => <CommandPaletteLoading />,
  }
);

function CommandPaletteLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4"
    >
      <div className="mt-24 flex items-center gap-2 rounded-lg border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Загрузка поиска…
      </div>
    </div>
  );
}

export function CommandPalette({ projects = [], onCreateTask }: CommandPaletteProps) {
  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  // The first open both requests the chunk and opens the dialog; after that the
  // component stays mounted so its query and Radix lifecycle behave as before.
  const openPalette = React.useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);

  // Ctrl/⌘+K follows the physical KeyK so it also works in non-Latin layouts
  // (Russian "л"), where `event.key` is not "k". The shared guard keeps it out
  // of editors, forms, open dialogs and already-handled events.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "k" && event.code !== "KeyK") return;
      if (shouldIgnoreGlobalHotkey(event)) return;
      event.preventDefault();
      openPalette();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [openPalette]);

  return (
    <>
      <button
        ref={triggerRef}
        data-command-palette
        onClick={openPalette}
        aria-label="Поиск обращений и направлений"
        className="flex h-11 min-w-11 items-center gap-2 px-3 py-2 text-sm text-muted-foreground bg-secondary/30 hover:bg-secondary/50 rounded-md transition-colors w-full max-w-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">Поиск обращений и направлений…</span>
        <kbd className="pointer-events-none hidden h-5 shrink-0 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:inline-flex">
          Ctrl/⌘ K
        </kbd>
      </button>

      {mounted && (
        <CommandPaletteDialog
          open={open}
          onOpenChange={setOpen}
          triggerRef={triggerRef}
          projects={projects}
          onCreateTask={onCreateTask}
        />
      )}
    </>
  );
}
