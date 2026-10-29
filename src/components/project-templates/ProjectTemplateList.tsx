"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { SUPPORT_TEMPLATE_ID, SUPPORT_BOARD_NAME } from "@/lib/project-template-catalog";

interface ProjectTemplate {
  id: string;
  name: string;
  description: string | null;
}

export function ProjectTemplateList({ onUseTemplate }: { onUseTemplate: (templateId: string) => void }) {
  const { data: templates = [], isLoading, error, refetch } = useQuery({
    queryKey: ["project-templates"],
    queryFn: ({ signal }) => apiFetch<ProjectTemplate[]>("/api/project-templates", { signal }),
  });
  if (isLoading) return <p role="status">Загрузка...</p>;
  if (error) return <div role="alert"><p>{error.message}</p><Button variant="outline" onClick={() => refetch()}>Повторить</Button></div>;
  const template = templates.find(item => item.id === SUPPORT_TEMPLATE_ID);
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h4 className="font-medium break-words">{SUPPORT_BOARD_NAME}</h4>
      <p className="text-sm text-muted-foreground break-words">{template?.description ?? "Новая → В работе → Ожидает ответа → Решена → Закрыта."}</p>
      <p className="text-sm text-muted-foreground">Доступен организации</p>
      <Button variant="outline" onClick={() => onUseTemplate(SUPPORT_TEMPLATE_ID)}>Использовать</Button>
    </div>
  );
}
