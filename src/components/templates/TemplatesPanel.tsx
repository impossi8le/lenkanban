"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TemplateList } from "@/components/templates/TemplateList";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

interface TemplatesPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

export function TemplatesPanel({ open, onOpenChange, projectId }: TemplatesPanelProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const useTemplateMutation = useMutation({
    mutationFn: async (templateId: string) => {
      return apiFetch(`/api/templates/${templateId}/use`, {
        method: "POST",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
      toast({
        title: "Задача создана",
        description: "Задача создана из шаблона",
      });
      onOpenChange(false);
    },
    onError: () => {
      toast({
        title: "Ошибка",
        description: "Не удалось создать задачу из шаблона",
        variant: "destructive",
      });
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-[540px] overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <SheetHeader>
          <SheetTitle>Шаблоны задач</SheetTitle>
          <SheetDescription>
            Используйте шаблоны для быстрого создания задач с предустановленными настройками
          </SheetDescription>
        </SheetHeader>
        <div className="mt-6">
          <TemplateList
            projectId={projectId}
            onUseTemplate={(templateId) => useTemplateMutation.mutate(templateId)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
