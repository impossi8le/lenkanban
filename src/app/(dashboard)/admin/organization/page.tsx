import { notFound } from "next/navigation";
import { isGlobalAdmin, requireDbUser } from "@/lib/require-user";
import DepartmentManager from "./DepartmentManager";

export const dynamic = "force-dynamic";

export default async function OrganizationPage() {
  const actor = await requireDbUser();
  if (!isGlobalAdmin(actor)) notFound();
  return <DepartmentManager key={actor.id} actorId={actor.id} />;
}
