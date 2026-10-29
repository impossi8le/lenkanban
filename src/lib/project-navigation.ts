/** Canonical client navigation for the three views served by the board route. */
export type ProjectView = "board" | "table" | "calendar";

export function parseProjectView(value: string | null): ProjectView | null {
  return value === "board" || value === "table" || value === "calendar" ? value : null;
}

export function parseProjectContext(pathname: string | null): { projectId: string } | null {
  const match = pathname?.match(/^\/projects\/([^/]+)\/(?:board\/?|tasks\/[^/]+\/?)$/);
  if (!match) return null;
  try {
    const projectId = decodeURIComponent(match[1]);
    if (!projectId || /[/\\\u0000-\u001f\u007f]/.test(projectId)) return null;
    return { projectId };
  } catch {
    return null;
  }
}

type SearchParams = { toString(): string };

export function projectViewHref(projectId: string, view: ProjectView, searchParams?: SearchParams): string {
  const params = new URLSearchParams(searchParams?.toString());
  params.set("view", view);
  params.delete("task");
  params.delete("create");
  return `/projects/${encodeURIComponent(projectId)}/board?${params}`;
}

export function projectCreateTaskHref(projectId: string, searchParams?: SearchParams): string {
  const params = new URLSearchParams(searchParams?.toString());
  params.set("view", parseProjectView(params.get("view")) ?? "board");
  params.set("create", "task");
  params.delete("task");
  return `/projects/${encodeURIComponent(projectId)}/board?${params}`;
}
