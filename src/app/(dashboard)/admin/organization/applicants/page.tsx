import { notFound } from "next/navigation";
import { requireDbUser, isGlobalAdmin } from "@/lib/require-user";
import ApplicantManager from "./ApplicantManager";

export const dynamic = "force-dynamic";
export default async function ApplicantsPage() {
  const actor = await requireDbUser();
  if (!isGlobalAdmin(actor)) notFound();
  return <ApplicantManager key={actor.id} actorId={actor.id} />;
}
