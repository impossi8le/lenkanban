import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireDbUser } from "@/lib/require-user";
import { getProjectReadWhere, requireProjectRead, getProjectAccess } from "@/lib/project-access";
import { getProjectCreationPolicy } from "@/lib/project-creation-policy";
import { AuthorizedDepartmentRedirect } from "@/components/dashboard/AuthorizedDepartmentRedirect";
import { ApplicantDirection } from "@/components/dashboard/ApplicantDirection";
import { requestDirectionDiscoveryWhere } from "@/lib/request-direction-discovery";
import { REQUEST_DEPARTMENTS, classifyDirectionName } from "@/lib/request-directions";

/** Portable public aliases resolve only freshly authorized destinations. */
export default async function DepartmentPage({ params, searchParams }: {
  params: Promise<{ kind: string }>;
  searchParams: Promise<{ create?: string | string[] }>;
}) {
  const { kind } = await params;
  const department = REQUEST_DEPARTMENTS.find(item => item.kind === kind);
  if (!department) notFound();
  const user = await requireDbUser();
  const create = (await searchParams).create === "task";
  const boards = await prisma.project.findMany({
    where: kind === "beznal" ? requestDirectionDiscoveryWhere(user, await getProjectReadWhere(user)) : await getProjectReadWhere(user), select: { id: true, name: true }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  for (const board of boards.filter(item => classifyDirectionName(item.name) === kind)) {
    // Recheck current read and creation policy at navigation, not from a client cache.
    if(kind === "beznal") {
      const access=await getProjectAccess(user,board.id);
      const creation=await getProjectCreationPolicy(user,board.id);
      if(!access.canRead) {
        if(creation.canCreate)return <ApplicantDirection projectId={board.id} projectName={board.name} initiallyOpen={create}/>;
        continue;
      }
      if(create && !creation.canCreate)continue;
      return <AuthorizedDepartmentRedirect href={`/projects/${encodeURIComponent(board.id)}/board?view=board${create ? "&create=task" : ""}`}/>;
    }
    await requireProjectRead(user, board.id);
    if (create && !(await getProjectCreationPolicy(user, board.id)).canCreate) continue;
    return <AuthorizedDepartmentRedirect href={`/projects/${encodeURIComponent(board.id)}/board?view=board${create ? "&create=task" : ""}`}/>;
  }
  return <section className="mx-auto max-w-xl p-8" aria-labelledby="department-heading">
    <h1 id="department-heading" className="text-2xl font-bold">{department.name}</h1>
    <p className="my-4 text-muted-foreground">{create ? "Сейчас нет доступного направления для создания обращения." : "Сейчас этот отдел вам недоступен или ещё не настроен."}</p>
    <Link href="/" className="inline-flex min-h-11 items-center rounded-lg border px-4 focus-visible:ring-2 focus-visible:ring-ring">На главную</Link>
  </section>;
}
