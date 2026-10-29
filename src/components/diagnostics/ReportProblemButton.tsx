"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { MessageSquareWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TelemetryScreen } from "@/lib/telemetry/catalog";
const ReportProblemDialog = dynamic(() => import("./ReportProblemDialog").then(module => module.ReportProblemDialog), { ssr: false });

/** Chooses a closed label locally; no pathname, IDs or query values leave the UI. */
export function problemReportScreen(pathname: string | null): TelemetryScreen {
  if (pathname === "/") return "home";
  if (pathname?.startsWith("/admin/telemetry")) return "admin.telemetry";
  if (pathname?.startsWith("/admin")) return "admin";
  if (pathname?.startsWith("/my-tasks")) return "my-tasks";
  if (pathname?.startsWith("/settings")) return "settings";
  if (pathname?.startsWith("/messages")) return "messages";
  if (pathname?.startsWith("/analytics")) return "analytics";
  return "board";
}
export function ReportProblemButton() {
  const { data: session, status } = useSession();
  const actorId = status === "authenticated" ? session?.user?.id : undefined;
  const pathname = usePathname();
  const [view, setView] = useState<{ actorId: string | undefined; open: boolean }>({ actorId: undefined, open: false });
  const trigger = useRef<HTMLButtonElement>(null);
  const open = Boolean(actorId && view.actorId === actorId && view.open);
  return <><Button ref={trigger} type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0" disabled={!actorId}
    title="Сообщить о проблеме" aria-label="Сообщить о проблеме" onClick={() => setView({ actorId, open: true })}><MessageSquareWarning className="h-5 w-5" aria-hidden="true" /></Button>
    {actorId && view.actorId === actorId && <ReportProblemDialog key={actorId} open={open} onOpenChange={next => setView({ actorId, open: next })} screen={problemReportScreen(pathname)} returnFocusRef={trigger} />}</>;
}
