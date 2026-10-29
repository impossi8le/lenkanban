"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import { getBrowserTelemetryClient, resetTelemetrySessionDisable } from "@/lib/telemetry/client";
import { observeBrowserRequests, observeControlActivations, screenForTelemetry } from "@/lib/telemetry/browser-observers";

export function TelemetryProvider({
  children,
  enabled,
}: {
  children: ReactNode;
  /** Server-computed availability. Disabled telemetry never opens a session. */
  enabled: boolean;
}) {
  const { data, status } = useSession();
  const actorId = status === "authenticated" ? data?.user?.id ?? null : null;
  const pathname = usePathname();
  const navigation = useRef({ pathname, actorId, enabled });
  navigation.current = { pathname, actorId, enabled };
  const lastPath = useRef<string | null>(null);
  const recordCurrentScreen = useCallback((client: ReturnType<typeof getBrowserTelemetryClient>) => {
    const current = navigation.current;
    if (!current.enabled || !current.actorId || lastPath.current === current.pathname) return;
    // Only the closed catalog label leaves this boundary, never the pathname.
    const screen = screenForTelemetry(current.pathname);
    try {
      if (screen ? client?.recordScreen(screen) : client?.recordNavigation('root')) lastPath.current = current.pathname;
    } catch { /* Diagnostics cannot block navigation. */ }
  }, []);
  useEffect(() => {
    // A disabled deployment must not create the client at all: every request
    // would be answered with 503 and show up as a failed resource on each load.
    if (!enabled) return;
    // A server-rendered "enabled" is authoritative for this page load, so a
    // stale session marker from an earlier disabled window is cleared.
    resetTelemetrySessionDisable();
    const client = getBrowserTelemetryClient();
    let active = true;
    let stopRequests = () => {}, stopControls = () => {};
    lastPath.current = null;
    void Promise.resolve(client?.setIdentity(actorId)).then(() => {
      if (active && client && actorId && navigation.current.actorId === actorId) {
        recordCurrentScreen(client);
        stopRequests = observeBrowserRequests(client);
        stopControls = observeControlActivations(client);
      }
    }).catch(() => undefined);
    return () => { active = false; stopRequests(); stopControls(); lastPath.current = null; void client?.setIdentity(null); };
  }, [actorId, status, enabled, recordCurrentScreen]);
  useEffect(() => {
    if (enabled && actorId) recordCurrentScreen(getBrowserTelemetryClient());
  }, [pathname, actorId, enabled, recordCurrentScreen]);
  return children;
}
