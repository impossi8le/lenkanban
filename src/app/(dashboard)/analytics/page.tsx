"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

const AnalyticsPage = dynamic(
  () => import("@/components/analytics/AnalyticsPage").then((mod) => ({ default: mod.AnalyticsPage })),
  {
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    ),
    ssr: false,
  }
);

export default function GlobalAnalyticsPage() {
  return <AnalyticsPage />;
}