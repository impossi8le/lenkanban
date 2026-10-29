"use client";

import * as React from "react";
import { SessionProvider } from "next-auth/react";
import { TelemetryProvider } from "./telemetry-provider";

export function AuthProvider({
  children,
  telemetryEnabled,
}: {
  children: React.ReactNode;
  /** Server-computed availability; the client never sees the secret. */
  telemetryEnabled: boolean;
}) {
  return (
    <SessionProvider>
      <TelemetryProvider enabled={telemetryEnabled}>{children}</TelemetryProvider>
    </SessionProvider>
  );
}
