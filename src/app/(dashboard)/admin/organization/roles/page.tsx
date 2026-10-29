import { notFound } from "next/navigation";
import { requireDbUser, isGlobalAdmin } from "@/lib/require-user";
import RoleManager from "./RoleManager";

export const dynamic = "force-dynamic";
export default async function RolesPage({ searchParams }: { searchParams?: Promise<{ userId?: string | string[] }> }) {
  const actor = await requireDbUser();
  if (!isGlobalAdmin(actor)) notFound();
  const value = (await searchParams)?.userId;
  const initialUserId = typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : "";
  return <RoleManager key={`${actor.id}:${initialUserId}`} actorId={actor.id} initialUserId={initialUserId} />;
}
