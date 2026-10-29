import { notFound } from "next/navigation";
import { requireDbUser, isGlobalAdmin } from "@/lib/require-user";
import RoleAssignmentManager from "./RoleAssignmentManager";

export const dynamic = "force-dynamic";
export default async function RoleAssignmentsPage() {
  const actor = await requireDbUser();
  if (!isGlobalAdmin(actor)) notFound();
  return <RoleAssignmentManager key={actor.id} actorId={actor.id} />;
}
