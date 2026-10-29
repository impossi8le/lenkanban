"use client";

import { useSession } from "next-auth/react";
import { MyDayWorkspace } from "@/features/my-day/MyDayWorkspace";
import { useMyDaySessionGuard } from "@/features/my-day/my-day-draft";

export default function MyDayPage() {
  const { data: session, status, update } = useSession();
  const actorId = session?.user?.id ?? null;

  useMyDaySessionGuard(actorId, status);

  if (status === "loading") {
    return (
      <p role="status" className="p-6 text-muted-foreground">
        Проверка учётной записи…
      </p>
    );
  }

  if (status !== "authenticated" || !actorId) {
    return (
      <p role="alert" className="p-6 text-muted-foreground">
        Войдите заново, чтобы открыть личный дневник «Мой день».
      </p>
    );
  }

  return <MyDayWorkspace key={actorId} actorId={actorId} onSessionChanged={() => update()} />;
}
