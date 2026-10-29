"use client";

import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { RecurringTaskList } from "@/components/recurring/RecurringTaskList";
import { RecurringTaskDialog } from "@/components/recurring/RecurringTaskDialog";

interface RecurringTasksPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

export function RecurringTasksPanel({ open, onOpenChange, projectId }: RecurringTasksPanelProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-[540px] overflow-y-auto p-4 sm:p-6 min-w-0 [overflow-wrap:anywhere]">
          <SheetHeader>
            <SheetTitle>Повторяющиеся задачи</SheetTitle>
            <SheetDescription>
              Автоматическое создание задач по расписанию
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-4">
            <Button
              onClick={() => setDialogOpen(true)}
              className="w-full gap-2"
            >
              <Plus className="h-4 w-4" />
              Создать повторяющуюся задачу
            </Button>
            <RecurringTaskList projectId={projectId} />
          </div>
        </SheetContent>
      </Sheet>

      <RecurringTaskDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={projectId}
      />
    </>
  );
}
