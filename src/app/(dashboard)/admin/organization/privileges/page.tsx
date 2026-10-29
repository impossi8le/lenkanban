import { notFound } from "next/navigation";
import { requireDbUser, isGlobalAdmin } from "@/lib/require-user";
import PrivilegeManager from "./PrivilegeManager";

export const dynamic = "force-dynamic";
export default async function PrivilegesPage() {
  const actor = await requireDbUser();
  if (!isGlobalAdmin(actor)) notFound();
  return <PrivilegeManager key={actor.id} actorId={actor.id} />;
}
