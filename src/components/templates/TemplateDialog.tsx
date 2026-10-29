"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import { getTaskPriorityPresentation } from "@/lib/task-priority";
import { useToast } from "@/hooks/use-toast";
import type { TaskType } from "@/components/kanban/Card";

interface TemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: TaskType;
}

export function TemplateDialog({ open, onOpenChange, task }: TemplateDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createTemplateMutation = useMutation({
    mutationFn: async (data: { name: string; description: string }) => {
      return apiFetch("/api/templates", {
        method: "POST",
        body: JSON.stringify({
          projectId: task.projectId,
          name: data.name,
          description: data.description,
          templateTitle: task.title,
          templateDescription: task.description,
          priority: task.priority,
          tags: task.tags?.map(t => t.tag.name) || [],
          checklistItems: task.checklistItems?.map(item => ({
            text: item.text,
            completed: item.completed,
          })) || [],
          estimatedDuration: null,
        }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["templates", task.projectId] });
      toast({
        title: "Шаблон создан",
        description: "Задача сохранена как шаблон",
      });
      setName("");
      setDescription("");
      onOpenChange(false);
    },
    onError: () => {
      toast({
        title: "Ошибка",
        description: "Не удалось создать шаблон",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast({
        title: "Ошибка",
        description: "Введите название шаблона",
        variant: "destructive",
      });
      return;
    }
    createTemplateMutation.mutate({ name, description });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 [overflow-wrap:anywhere] sm:max-w-[500px] sm:p-6">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Сохранить как шаблон</DialogTitle>
            <DialogDescription>
              Создайте шаблон на основе этой задачи для быстрого создания похожих задач
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="template-name">Название шаблона *</Label>
              <Input
                id="template-name"
                placeholder="Например: Bug Report Template"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={createTemplateMutation.isPending}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="template-description">Описание</Label>
              <Textarea
                id="template-description"
                placeholder="Опишите когда использовать этот шаблон"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={createTemplateMutation.isPending}
                rows={3}
              />
            </div>

            <div className="rounded-lg border p-3 space-y-2 bg-muted/50">
              <p className="text-sm font-medium">Что будет включено:</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Заголовок: {task.title}</li>
                <li>• Приоритет: {getTaskPriorityPresentation(task.priority).label}</li>
                {task.tags && task.tags.length > 0 && (
                  <li>• Теги: {task.tags.map(t => t.tag.name).join(", ")}</li>
                )}
                {task.checklistItems && task.checklistItems.length > 0 && (
                  <li>• Чек-лист: {task.checklistItems.length} пунктов</li>
                )}
                {task.description && <li>• Описание задачи</li>}
              </ul>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createTemplateMutation.isPending}
            >
              Отмена
            </Button>
            <Button type="submit" disabled={createTemplateMutation.isPending}>
              {createTemplateMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Создать шаблон
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
