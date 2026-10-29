import { getProjectRequestExecutionPolicy } from "@/lib/project-request-execution-policy";
import { ProjectBoardClient } from "./ProjectBoardClient";
import { requireDbUser } from "@/lib/require-user";
import { requireProjectRead } from "@/lib/project-access";
import { getProjectCreationPolicy } from "@/lib/project-creation-policy";
import { getProjectStatusPolicy } from "@/lib/project-status-policy";
import { notFound } from "next/navigation";

export default async function ProjectBoardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = await params;

  try {
    const user = await requireDbUser();
    const access = await requireProjectRead(user, resolvedParams.id);

    // Members should not see members management UI. API returns 404 as well.
    const canManage = access.canManageMembers;
    const [creation, status, execution] = await Promise.all([
      getProjectCreationPolicy(user, resolvedParams.id),
      getProjectStatusPolicy(user, resolvedParams.id),
      getProjectRequestExecutionPolicy(user.id, resolvedParams.id),
    ]);

    return <ProjectBoardClient projectId={resolvedParams.id} canManage={canManage} canCreate={creation.canCreate} allowedCreationColumnIds={creation.allowedColumnIds} canExecuteRequests={execution.canExecute} canChangeStatus={status.canChangeStatus} />;
  } catch (error) {
    console.error("[board/page] Error:", error);
    notFound();
  }
}
