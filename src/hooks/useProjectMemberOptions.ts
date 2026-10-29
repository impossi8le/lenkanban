"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { getSocketInstance } from "@/lib/socket-client";

export type ProjectMemberIdentity = {
  id: string;
  name: string | null;
  email: string;
  avatarUrl?: string | null;
};

/** The public roster is an object. Filter arrays are observer projections only. */
export type ProjectMemberRoster = {
  owner: ProjectMemberIdentity | null;
  items: Array<{ userId?: string; user: ProjectMemberIdentity }>;
};
export type ProjectMemberOption = {
  userId: string;
  user: { id: string; name: string; email: string; avatarUrl?: string | null };
};

type RosterKey = readonly ["project-members", string];
const readRoster = ({ queryKey, signal }: QueryFunctionContext<RosterKey>) =>
  apiFetch<ProjectMemberRoster>(`/api/projects/${encodeURIComponent(queryKey[1])}/members`, { signal });

const pending = new WeakMap<QueryClient, Set<string>>();
function refreshRoster(client: QueryClient, projectId: string) {
  let projects = pending.get(client);
  if (!projects) { projects = new Set(); pending.set(client, projects); }
  if (projects.has(projectId)) return;
  projects.add(projectId);
  queueMicrotask(() => {
    projects.delete(projectId);
    void client.invalidateQueries({ queryKey: ["project-members", projectId], exact: true });
    // The legacy management dialog still owns its separate cache. Keep socket
    // updates compatible without changing its mutation or management contract.
    void client.invalidateQueries({ queryKey: ["projectMembers", projectId], exact: true });
    void client.invalidateQueries({ queryKey: ["tasks", projectId] });
  });
}

function useRosterEvents(projectId: string, enabled: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled || !projectId) return;
    const socket = getSocketInstance();
    const refresh = (payload?: { projectId?: string }) => {
      // Some existing PATCH broadcasts contain only the member DTO, without a
      // projectId. They must still reconcile active rosters, never grant rights.
      if (payload?.projectId && payload.projectId !== projectId) return;
      refreshRoster(client, projectId);
    };
    socket.on("project:members:updated", refresh);
    socket.on("project:member:deleted", refresh);
    return () => {
      socket.off("project:members:updated", refresh);
      socket.off("project:member:deleted", refresh);
    };
  }, [client, projectId, enabled]);
}

export function toProjectMemberOptions(roster: ProjectMemberRoster): ProjectMemberOption[] {
  const identities = new Map<string, ProjectMemberIdentity>();
  if (roster?.owner) identities.set(roster.owner.id, roster.owner);
  for (const item of roster?.items ?? []) if (!identities.has(item.user.id)) identities.set(item.user.id, item.user);
  return [...identities.values()].map(user => ({ userId: user.id, user: { ...user, name: user.name ?? user.email } }));
}

export function useProjectMemberOptions(projectId: string, enabled = true) {
  useRosterEvents(projectId, enabled);
  return useQuery({ queryKey: ["project-members", projectId] as const, queryFn: readRoster,
    enabled: enabled && Boolean(projectId), select: toProjectMemberOptions });
}

export function useProjectMemberRoster(projectId: string, enabled = true) {
  useRosterEvents(projectId, enabled);
  return useQuery({ queryKey: ["project-members", projectId] as const, queryFn: readRoster,
    enabled: enabled && Boolean(projectId) });
}
