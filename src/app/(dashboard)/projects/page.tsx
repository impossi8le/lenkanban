"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, FolderKanban, Plus, ArrowUpRight } from "lucide-react";
import { apiFetch } from "@/lib/api";

const ProjectTemplatesPanel = dynamic(() => import("@/components/project-templates/ProjectTemplatesPanel").then(module => module.ProjectTemplatesPanel), { ssr: false });
const BoardCreationDialog = dynamic(() => import("@/components/project-templates/BoardCreationDialog").then(module => module.BoardCreationDialog), { ssr: false });

type Project = {
  id: string;
  name: string;
  description?: string | null;
  _count?: {
    tasks: number;
  };
};

export default function ProjectsPage() {
  const { data: session, status } = useSession();
  const adminActorId = status === "authenticated" && session?.user?.globalRole === "ADMIN" ? session.user.id : undefined;

  const { data: projects, isLoading, isError } = useQuery({
    queryKey: ["projects"],
    queryFn: ({ signal }) => apiFetch<Project[]>("/api/projects", { signal }),
  });

  return (
    <div className="h-full overflow-auto p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Запросы в отделы</h1>
          <p className="mt-2 text-sm text-muted-foreground">Выберите отдел, чтобы оставить обращение или посмотреть его состояние.</p>
        </div>

        {adminActorId && <ProjectAdminTools key={adminActorId} />}
      </div>

      {isLoading ? (
        <div role="status" aria-live="polite" className="text-muted-foreground animate-pulse">
          Загрузка проектов…
        </div>
      ) : isError ? (
        <div role="alert" aria-live="assertive" className="text-destructive">
          Не удалось загрузить проекты.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {(projects ?? []).map((p) => (
            <Link
              key={p.id}
               href={`/projects/${p.id}/board`}
              className="group min-w-0 rounded-xl border bg-card p-5 hover:border-primary transition-colors focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="mb-5 flex items-center justify-between"><FolderKanban className="h-5 w-5 text-primary" aria-hidden="true" /><ArrowUpRight className="h-4 w-4 text-muted-foreground group-hover:text-primary" aria-hidden="true" /></div>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{p.name}</div>
                  {p.description ? (
                    <div className="min-w-0 max-w-full text-xs text-muted-foreground line-clamp-2 [overflow-wrap:anywhere] mt-1">{p.description}</div>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground whitespace-nowrap">
                  {(p._count?.tasks ?? 0).toString()} задач
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {!isLoading && !isError && (projects?.length ?? 0) === 0 ? (
        <div className="mt-6 text-muted-foreground">
          {adminActorId ? <>Пока нет проектов. Нажмите &quot;Новый проект&quot;, чтобы создать.</> : "Пока нет доступных проектов."}
        </div>
      ) : null}

    </div>
  );
}

// Mount only for a known current global administrator; revocation/unresolved session
// unmounts both tools and their intent so another actor cannot inherit open panels.
function ProjectAdminTools() {
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templatesMounted, setTemplatesMounted] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  return <>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { setTemplatesMounted(true); setTemplatesOpen(true); }}
            className="inline-flex h-11 items-center justify-center rounded-lg border bg-card px-3 text-sm font-medium shadow-sm hover:bg-accent transition-colors gap-2"
          >
            <FolderOpen className="h-4 w-4" />
            Шаблоны
          </button>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground px-4 text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />Новый проект
          </button>
        </div>
    {templatesMounted && <ProjectTemplatesPanel open={templatesOpen} onOpenChange={setTemplatesOpen} />}
    {createOpen && <BoardCreationDialog open onOpenChange={setCreateOpen} />}
  </>;
}
