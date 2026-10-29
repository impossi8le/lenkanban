import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { getSocketInstance } from "@/lib/socket-client";

export type ProjectMember = {
  id: string;
  userId: string;
  role: "MEMBER" | "PROJECT_ADMIN";
  user: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
  };
  addedById: string | null;
  createdAt: string;
};

export type ProjectMembersResponse = {
  owner: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
  };
  members: ProjectMember[];
};

export function useProjectMembers(projectId: string | undefined) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: async () => {
      if (!projectId) throw new Error("ID проекта обязателен");
      return apiFetch<ProjectMembersResponse>(`/api/projects/${projectId}/members`);
    },
    enabled: !!projectId,
    staleTime: 30_000, // 30 seconds
  });

  // Listen for real-time updates via Socket.IO
  useEffect(() => {
    if (!projectId) return;

    const socket = getSocketInstance();

    const handleMembersUpdated = () => {
      // Invalidate and refetch project members query
      queryClient.invalidateQueries({ queryKey: ["project-members", projectId] });
    };

    const handleMemberDeleted = () => {
      // Invalidate and refetch project members query
      queryClient.invalidateQueries({ queryKey: ["project-members", projectId] });
    };

    // Listen for member update events
    socket.on("project:members:updated", handleMembersUpdated);
    socket.on("project:member:deleted", handleMemberDeleted);

    return () => {
      socket.off("project:members:updated", handleMembersUpdated);
      socket.off("project:member:deleted", handleMemberDeleted);
    };
  }, [projectId, queryClient]);

  return query;
}
