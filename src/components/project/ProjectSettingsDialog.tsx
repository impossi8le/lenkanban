"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, apiPatch } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings } from "lucide-react";

interface Project {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
}

interface ProjectSettingsDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProjectSettingsDialog({
  projectId,
  open,
  onOpenChange,
}: ProjectSettingsDialogProps) {
  // Fetch project data
  const { data: project, isLoading, isError } = useQuery({
    queryKey: ["project", projectId],
    queryFn: ({ signal }) => apiFetch<Project>(`/api/projects/${projectId}`, { signal }),
    enabled: open,
  });

  if (isLoading) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:p-6 min-w-0 [overflow-wrap:anywhere]">
          <div role="status" aria-live="polite" aria-busy="true" aria-label="Загрузка настроек проекта…">
            <div aria-hidden="true" className="space-y-4">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (!project) {
    if (!open) return null;
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:p-6 min-w-0 [overflow-wrap:anywhere]">
          <div role={isError ? "alert" : "status"} className="py-8 text-center text-muted-foreground">
            {isError
              ? "Не удалось загрузить настройки проекта. Закройте окно и попробуйте снова."
              : "Настройки проекта недоступны."}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:p-6 min-w-0 [overflow-wrap:anywhere]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Название проекта
          </DialogTitle>
        </DialogHeader>

        <GeneralSettings project={project} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function GeneralSettings({ project, onClose }: { project: Project; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description || "");

  const updateProjectMutation = useMutation({
    mutationFn: (data: { name?: string; description?: string | null }) =>
      apiPatch(`/api/projects/${project.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Проект обновлен", {
        description: "Изменения сохранены успешно",
      });
    },
    onError: () => {
      toast.error("Не удалось обновить проект", {
        description: "Попробуйте еще раз",
      });
    },
  });

  const handleSave = () => {
    updateProjectMutation.mutate({
      name: name.trim(),
      description: description.trim() || null,
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="project-name">Название проекта</Label>
        <Input
          id="project-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Введите название проекта"
          maxLength={100}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="project-description">Описание</Label>
        <Textarea
          id="project-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Введите описание проекта (необязательно)"
          rows={4}
          maxLength={500}
        />
      </div>

      <div className="flex flex-col-reverse sm:flex-row justify-end gap-2">
        <Button variant="outline" className="w-full sm:w-auto" onClick={onClose}>
          Отмена
        </Button>
        <Button
          className="w-full sm:w-auto"
          onClick={handleSave}
          disabled={!name.trim() || updateProjectMutation.isPending}
        >
          {updateProjectMutation.isPending ? "Сохранение..." : "Сохранить"}
        </Button>
      </div>
    </div>
  );
}
