import { notFound } from "next/navigation";
import { requireDbUser, isGlobalAdmin } from "@/lib/require-user";
import BindingManager from "./BindingManager";

export const dynamic = "force-dynamic";
export default async function BindingsPage() {
  const actor = await requireDbUser();
  if (!isGlobalAdmin(actor)) notFound();
  return <BindingManager key={actor.id} actorId={actor.id} />;
}
