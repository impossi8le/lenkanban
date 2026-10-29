"use client";

import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { ProjectTemplateList } from "./ProjectTemplateList";
import { BoardCreationDialog } from "./BoardCreationDialog";

interface ProjectTemplatesPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProjectTemplatesPanel({ open, onOpenChange }: ProjectTemplatesPanelProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [presetTemplateId, setPresetTemplateId] = useState<string | null>(null);

  const openCreate = (templateId: string | null) => {
    setPresetTemplateId(templateId);
    setCreateOpen(true);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto p-4 sm:p-6 min-w-0 [overflow-wrap:anywhere]">
          <SheetHeader>
            <SheetTitle>Доски и шаблоны</SheetTitle>
          </SheetHeader>
          <div className="mt-6 space-y-4">
            <Button className="w-full" onClick={() => openCreate(null)}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Создать доску
            </Button>
            <ProjectTemplateList onUseTemplate={(templateId) => openCreate(templateId)} />
          </div>
        </SheetContent>
      </Sheet>

      <BoardCreationDialog
        key={presetTemplateId ?? "empty"}
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialTemplateId={presetTemplateId}
      />
    </>
  );
}
