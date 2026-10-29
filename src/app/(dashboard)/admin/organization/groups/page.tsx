import { notFound } from "next/navigation";
import { requireDbUser, isGlobalAdmin } from "@/lib/require-user";
import GroupManager from "./GroupManager";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  const actor = await requireDbUser();
  if (!isGlobalAdmin(actor)) notFound();
  return <GroupManager key={actor.id} actorId={actor.id} />;
}
