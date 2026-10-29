import { notFound } from "next/navigation";
import { requireDbUser, isGlobalAdmin } from "@/lib/require-user";
import DebugSearchClient from "./DebugSearchClient";

export const dynamic = "force-dynamic";

export default async function DebugSearchPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  let actor;
  try {
    actor = await requireDbUser();
  } catch {
    notFound();
  }
  if (!isGlobalAdmin(actor)) notFound();
  return <DebugSearchClient />;
}
