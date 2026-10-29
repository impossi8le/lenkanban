"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, FileText, Tag, CheckSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/api";
import { getTaskPriorityPresentation } from "@/lib/task-priority";
import { useToast } from "@/hooks/use-toast";

interface Template {
  id: string;
  name: string;
  description: string | null;
  templateTitle: string;
  templateDescription: string | null;
  priority: string;
  tags: string[];
  checklistItems: Array<{ text: string; completed: boolean }>;
  createdBy: {
    id: string;
    name: string | null;
    email: string;
  };
  createdAt: string;
}

interface TemplateListProps {
  projectId: string;
  onUseTemplate: (templateId: string) => void;
}

export function TemplateList({ projectId, onUseTemplate }: TemplateListProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: templates, isLoading } = useQuery({
    queryKey: ["templates", projectId],
    queryFn: ({ signal }) => apiFetch<Template[]>(`/api/templates?projectId=${projectId}`, { signal }),
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: async (templateId: string) => {
      return apiFetch(`/api/templates/${templateId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["templates", projectId] });
      toast({
        title: "Шаблон удален",
        description: "Шаблон успешно удален",
      });
    },
    onError: () => {
      toast({
        title: "Ошибка",
        description: "Не удалось удалить шаблон",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 role="status" aria-live="polite" className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!templates || templates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <FileText className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-semibold mb-2">Нет шаблонов</h3>
        <p className="text-sm text-muted-foreground max-w-sm">
          Сохраните задачу как шаблон, чтобы быстро создавать похожие задачи в будущем
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {templates.map((template) => (
        <Card key={template.id}>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1 min-w-0 flex-1 break-words">
                <CardTitle className="text-base">{template.name}</CardTitle>
                {template.description && (
                  <CardDescription className="text-sm">
                    {template.description}
                  </CardDescription>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Удалить шаблон: ${template.name}`}
                onClick={() => {
                  if (window.confirm(`Удалить шаблон «${template.name}»? Это действие нельзя отменить.`)) {
                    deleteTemplateMutation.mutate(template.id);
                  }
                }}
                disabled={deleteTemplateMutation.isPending}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">Заголовок:</span>
                <span className="min-w-0 max-w-full font-medium [overflow-wrap:anywhere]">{template.templateTitle}</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge className={getTaskPriorityPresentation(template.priority).color}>
                  {getTaskPriorityPresentation(template.priority).label}
                </Badge>
              </div>
            </div>

            {template.tags.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <Tag className="h-3 w-3 text-muted-foreground" />
                {template.tags.map((tag, idx) => (
                  <Badge key={idx} variant="outline" className="max-w-full whitespace-normal break-words text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}

            {template.checklistItems.length > 0 && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckSquare className="h-3 w-3" />
                <span>{template.checklistItems.length} пунктов чек-листа</span>
              </div>
            )}

            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 pt-2 border-t">
              <span className="min-w-0 max-w-full text-xs text-muted-foreground [overflow-wrap:anywhere]">
                Создан: {template.createdBy.name || template.createdBy.email}
              </span>
              <Button
                size="sm"
                onClick={() => onUseTemplate(template.id)}
              >
                Использовать
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
