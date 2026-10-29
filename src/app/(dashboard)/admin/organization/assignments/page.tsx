import { notFound } from "next/navigation";
import { requireDbUser, isGlobalAdmin } from "@/lib/require-user";
import AssignmentManager from "./AssignmentManager";

export const dynamic = "force-dynamic";

export default async function AssignmentsPage() {
  const actor = await requireDbUser();
  if (!isGlobalAdmin(actor)) notFound();
  return <AssignmentManager key={actor.id} actorId={actor.id} />;
}
