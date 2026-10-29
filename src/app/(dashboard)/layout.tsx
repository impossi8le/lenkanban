"use client";

import * as React from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { useGlobalHotkeys } from "@/hooks/useGlobalHotkeys";
import { RequestDialogProvider } from "@/components/task/RequestDialogProvider";
import { SessionReadBoundary } from "@/components/dashboard/SessionReadBoundary";

function DashboardHotkeys({
  onToggleSidebar,
  onOpenCommandPalette,
}: {
  onToggleSidebar: () => void;
  onOpenCommandPalette: () => void;
}) {
  useGlobalHotkeys({ onToggleSidebar, onOpenCommandPalette });
  return null;
}

// Persisted desktop sidebar preference. Reading it after mount keeps the
// server markup deterministic, so hydration cannot mismatch on the class.
const SIDEBAR_STORAGE_KEY = "lenkanban-sidebar-state";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  const [preferenceReady, setPreferenceReady] = React.useState(false);

  React.useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (stored === "collapsed") setIsCollapsed(true);
      else if (stored === "expanded") setIsCollapsed(false);
    } catch {
      // Storage can be unavailable (private mode, blocked cookies): keep default.
    }
    setPreferenceReady(true);
  }, []);

  React.useEffect(() => {
    if (!preferenceReady) return;
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, isCollapsed ? "collapsed" : "expanded");
    } catch {
      // A failed write must not break navigation; the session still works.
    }
  }, [isCollapsed, preferenceReady]);

  const toggleSidebar = () => setIsCollapsed((prev) => !prev);

  const handleOpenCommandPalette = () => {
    // Trigger command palette
    const commandPaletteButton = document.querySelector('[data-command-palette]') as HTMLElement;
    commandPaletteButton?.click();
  };

  return (
    <RequestDialogProvider><div className="flex h-dvh w-full overflow-hidden bg-background">
      <React.Suspense fallback={null}>
        <DashboardHotkeys
          onToggleSidebar={toggleSidebar}
          onOpenCommandPalette={handleOpenCommandPalette}
        />
      </React.Suspense>
      {/* Sidebar - hidden on mobile, collapsible on desktop */}
      <div className="hidden md:flex flex-shrink-0 transition-[width] duration-200">
        <div className={isCollapsed ? "w-[76px]" : "w-[256px]"}>
          <Sidebar isCollapsed={isCollapsed} onToggle={toggleSidebar} />
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <Header />
        <main id="main-content" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-background/95">
          <SessionReadBoundary>{children}</SessionReadBoundary>
        </main>
      </div>
    </div></RequestDialogProvider>
  );
}
