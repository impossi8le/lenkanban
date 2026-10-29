"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { apiPost } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { createProjectSchema } from "@/lib/validators";

function defaultTemplateName(projectName: string) {
  const suffix = " — шаблон";
  return `${projectName.trim().slice(0, 120 - suffix.length).trimEnd()}${suffix}`;
}

interface ProjectTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
}

export function ProjectTemplateDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
}: ProjectTemplateDialogProps) {
  const [name, setName] = useState(() => defaultTemplateName(projectName));
  const [description, setDescription] = useState("");
  const [availability, setAvailability] = useState<"creator" | "organization">("creator");
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description: string; projectId: string; availability: "creator" | "organization" }) => apiPost("/api/project-templates", data),
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-templates"] });
      toast.success("Шаблон проекта создан");
      onOpenChange(false);
      resetForm();
    },
    onError: (failure) => {
      const rateLimited = typeof failure === "object" && failure !== null && "status" in failure && failure.status === 429;
      const message = rateLimited ? "Слишком много запросов. Подождите немного и попробуйте снова." : "Не удалось создать шаблон проекта";
      setError(rateLimited ? message : failure instanceof Error ? failure.message : message);
      toast.error(message);
    },
    onSettled: () => { submittingRef.current = false; },
  });

  const resetForm = () => {
    setName(defaultTemplateName(projectName));
    setDescription("");
    setAvailability("creator");
    setError(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    const parsed = createProjectSchema.safeParse({ name, description });
    if (!parsed.success) {
      setError("Укажите название до 120 символов и описание до 10 000 символов.");
      return;
    }
    submittingRef.current = true;
    setError(null);
    createMutation.mutate({
      name: parsed.data.name,
      description: parsed.data.description ?? "",
      projectId,
      availability,
    });
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!submittingRef.current) onOpenChange(next); }}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:p-6 min-w-0 sm:max-w-lg [overflow-wrap:anywhere]"
        onEscapeKeyDown={event => { if (submittingRef.current) event.preventDefault(); }}
        onInteractOutside={event => { if (submittingRef.current) event.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle className="break-words [overflow-wrap:anywhere]">Сохранить как шаблон проекта</DialogTitle>
          <DialogDescription className="break-words [overflow-wrap:anywhere]">Сохраните структуру проекта для повторного использования.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" aria-busy={createMutation.isPending}>
          <div>
            <Label htmlFor="name">Название шаблона</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Мой шаблон проекта"
              required
              maxLength={120}
              disabled={createMutation.isPending}
            />
          </div>

          <div>
            <Label htmlFor="description">Описание</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Описание шаблона..."
              rows={3}
              maxLength={10000}
              disabled={createMutation.isPending}
            />
          </div>

          <fieldset className="space-y-2" disabled={createMutation.isPending}>
            <legend className="text-sm font-medium">Кому доступен шаблон</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="templateAvailability"
                value="creator"
                checked={availability === "creator"}
                onChange={() => setAvailability("creator")}
                disabled={createMutation.isPending}
              />
              Только мне
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="templateAvailability"
                value="organization"
                checked={availability === "organization"}
                onChange={() => setAvailability("organization")}
                disabled={createMutation.isPending}
              />
              Всем глобальным администраторам
            </label>
          </fieldset>

          <div className="text-sm text-muted-foreground space-y-1">
            <p className="font-medium">Что будет сохранено:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Колонки проекта (названия, цвета, порядок)</li>
              <li>Теги проекта (названия, цвета)</li>
            </ul>
            <p>Участники, права и карточки проекта в шаблон не попадают.</p>
          </div>

          {createMutation.isPending && <p role="status" className="text-sm text-muted-foreground">Сохраняем шаблон. Дождитесь результата перед закрытием формы.</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-2">
            <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={createMutation.isPending} onClick={() => { if (!submittingRef.current) onOpenChange(false); }}>
              Отмена
            </Button>
            <Button type="submit" className="w-full sm:w-auto" disabled={createMutation.isPending || !name.trim()}>
              {createMutation.isPending ? "Сохранение..." : "Сохранить шаблон"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
