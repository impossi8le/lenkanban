import { notFound } from "next/navigation";
import { isGlobalAdmin, requireDbUser } from "@/lib/require-user";
import TelemetryDashboard from "./TelemetryDashboard";

export const dynamic = "force-dynamic";

export default async function AdminTelemetryPage() {
  const user = await requireDbUser();
  if (!isGlobalAdmin(user)) notFound();
  return <TelemetryDashboard serverNow={new Date().toISOString()} />;
}
