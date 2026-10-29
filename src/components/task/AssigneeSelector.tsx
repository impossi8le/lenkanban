"use client";
import {SearchHighlight} from "@/components/ui/SearchHighlight";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useProjectMemberRoster } from "@/hooks/useProjectMemberOptions";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface User {
  id: string;
  name: string | null;
  email: string;
  avatarUrl?: string | null;
}

interface AssigneeSelectorProps {
  projectId: string;
  taskId: string;
  selectedAssignees: Array<{ id: string; user: User }>;
  onAssigneesChange: (assignees: Array<{ id: string; user: User }>) => void;
}

export function AssigneeSelector({
  projectId,
  taskId,
  selectedAssignees,
  onAssigneesChange,
}: AssigneeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search,setSearch] = useState("");
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const actorId = session?.user?.id;
  const permission = useQuery({
    queryKey: ["task-status-permission", actorId, projectId],
    queryFn: ({ signal }) => apiFetch<{ canChangeStatus: boolean; canAssign?: boolean }>(`/api/projects/${projectId}/task-permissions`, { signal }),
    enabled: Boolean(actorId),
  });
  const canAssign = Boolean(actorId && (permission.data?.canAssign ?? permission.data?.canChangeStatus) === true && !permission.isError);

  const { data: membersData } = useProjectMemberRoster(projectId, canAssign);

  const updateAssigneesMutation = useMutation({
    mutationFn: async ({ taskId, userIds }: { taskId: string; projectId: string; userIds: string[] }) => {
      return fetch(`/api/tasks/${taskId}/assignees`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds }),
      }).then((r) => {
        if (!r.ok) throw new Error("Не удалось обновить исполнителей");
        return r.json();
      });
    },
    onSuccess: (_data, { taskId, projectId }) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
      queryClient.invalidateQueries({ queryKey: ["activities", taskId] });
      toast.success("Исполнители обновлены");
    },
    onError: (error) => {
      toast.error("Не удалось обновить исполнителей", {
        description: error instanceof Error ? error.message : "Попробуйте еще раз",
      });
    },
  });

  const allMembers: User[] = (() => {
    const membersMap = new Map<string, User>();

    // Add owner first
    if (membersData?.owner) {
      membersMap.set(membersData.owner.id, membersData.owner);
    }

    // Add members (owner will be deduplicated if also a member)
    membersData?.items?.forEach((m) => {
      membersMap.set(m.user.id, m.user);
    });

    return Array.from(membersMap.values());
  })();

  const toggleAssignee = (user: User) => {
    if (!canAssign || updateAssigneesMutation.isPending) return;
    const isSelected = selectedAssignees.some((a) => a.user.id === user.id);
    let newAssignees;

    if (isSelected) {
      newAssignees = selectedAssignees.filter((a) => a.user.id !== user.id);
    } else {
      newAssignees = [
        ...selectedAssignees,
        { id: `temp_${user.id}`, user },
      ];
    }

    updateAssigneesMutation.mutate({ taskId, projectId, userIds: newAssignees.map((a) => a.user.id) }, {
      onSuccess: () => onAssigneesChange(newAssignees),
    });
  };

  if (!canAssign) return null;

  return (
    <Popover open={open} onOpenChange={next=>{setOpen(next);if(!next)setSearch("");}}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={updateAssigneesMutation.isPending} className="min-w-0 max-w-full gap-2">
          <UserPlus className="h-4 w-4" />
          Исполнители
          {selectedAssignees.length > 0 && (
            <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs">
              {selectedAssignees.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-1rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-0" align="start">
        <Command>
          <CommandInput className="min-w-0" aria-label="Поиск участников" placeholder="Поиск участников..." value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>Участники не найдены</CommandEmpty>
            <CommandGroup>
              {allMembers.map((user) => {
                const isSelected = selectedAssignees.some(
                  (a) => a.user.id === user.id
                );
                return (
                  <CommandItem
                    key={user.id}
                    value={user.id}
                    keywords={[user.name ?? "", user.email]}
                    onSelect={() => toggleAssignee(user)}
                    className="min-h-11 min-w-0"
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4 shrink-0",
                        isSelected ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <Avatar className="h-6 w-6 mr-2 shrink-0">
                      <AvatarFallback className="text-xs">
                        {(user.name || user.email)[0].toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 [overflow-wrap:anywhere]"><SearchHighlight text={user.name || user.email} query={search}/></span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>

        {selectedAssignees.length > 0 && (
          <div className="border-t p-3">
            <div className="text-xs font-medium text-muted-foreground mb-2">
              Назначено:
            </div>
            <div className="flex flex-wrap gap-2">
              {selectedAssignees.map((assignment) => (
                <div
                  key={assignment.id}
                  className="flex min-w-0 max-w-full items-center gap-1 bg-secondary rounded-2xl pl-1 pr-2 py-1"
                >
                  <Avatar className="h-5 w-5 shrink-0">
                    <AvatarFallback className="text-xs">
                      {(assignment.user.name || assignment.user.email)[0].toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 text-xs [overflow-wrap:anywhere]">
                    {assignment.user.name || assignment.user.email}
                  </span>
                  <button
                    type="button"
                    aria-label={`Убрать исполнителя: ${assignment.user.name || assignment.user.email}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleAssignee(assignment.user);
                    }}
                    className="ml-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
