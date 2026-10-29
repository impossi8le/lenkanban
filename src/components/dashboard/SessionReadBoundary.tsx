"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { Loader2 } from "lucide-react";

/** Keep the public shell visible without starting private reads twice on boot. */
export function SessionReadBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const actorId = session?.user?.id;
  // Home streams its own authorized server sections; its static shell and
  // quick-start cards must not wait for the browser's session request.
  if (pathname !== "/" && status === "loading" && !actorId) {
    return <div role="status" className="flex min-h-64 items-center justify-center gap-2 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />Подготавливаем рабочее пространство…
    </div>;
  }
  return children;
}
