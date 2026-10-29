import type { User, Prisma } from "@prisma/client";
import { projectReadPredicate } from "@/lib/access-policy";

/** Metadata candidates only. Every result still requires the shared creation policy.
 * Applicant permission never grants task reads, execution or board management. */
export function requestDirectionDiscoveryWhere(actor: Pick<User,"id"|"globalRole">, readable: Prisma.ProjectWhereInput = projectReadPredicate(actor)): Prisma.ProjectWhereInput {
 return {OR:[readable,{name:{equals:"Безнал ОП",mode:"insensitive"}}]};
}
