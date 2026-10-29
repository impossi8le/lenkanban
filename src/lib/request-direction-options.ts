import type { User } from "@prisma/client";
import { classifyDirectionName } from "@/lib/request-directions";
import { getProjectCreationPolicy } from "@/lib/project-creation-policy";
import type { QuickStartDirections } from "@/components/dashboard/QuickStart";

/** Readability is established by the caller; creation uses the shared policy. */
export async function resolveRequestDirections(user: Pick<User, "id" | "globalRole">, boards: Array<{ id: string; name: string }>): Promise<QuickStartDirections> {
  const resolve = async (kind: "support" | "claim" | "beznal") => {
    for (const board of boards.filter(board => classifyDirectionName(board.name) === kind).slice(0, 3)) {
      const policy = await getProjectCreationPolicy(user, board.id);
      if (policy.canCreate) return { projectId: board.id, projectName: board.name };
    }
    return undefined;
  };
  const [support, claim, beznal] = await Promise.all([resolve("support"), resolve("claim"), resolve("beznal")]);
  return { support, claim, beznal };
}
