"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RouteLoading } from "@/components/ui/route-loading";
import { cn } from "@/lib/utils";

// This bounds the pending presentation, not the underlying Next server request.
export function TaskRoutePending({ variant = "task", overlay = false }: {
  variant?: "task" | "board";
  overlay?: boolean;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 15_000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className={cn(overlay && "fixed inset-0 z-50 overflow-auto bg-background")}>
      {slow ? (
        <div role="alert" className="flex min-h-48 flex-col items-center justify-center gap-4 p-6 text-center">
          <p>Загрузка занимает больше времени, чем обычно.</p>
          <Button variant="outline" onClick={() => window.location.reload()}>Обновить страницу</Button>
        </div>
      ) : (
        <RouteLoading variant={variant} label={variant === "board" ? "Загрузка доски…" : "Загрузка карточки задачи…"} />
      )}
    </div>
  );
}
