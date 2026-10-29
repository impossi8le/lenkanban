"use client";

import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { AutomationRuleList } from "./AutomationRuleList";
import { AutomationRuleDialog } from "./AutomationRuleDialog";

interface AutomationRulesPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

export function AutomationRulesPanel({ open, onOpenChange, projectId }: AutomationRulesPanelProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto p-4 sm:p-6 min-w-0 [overflow-wrap:anywhere]">
          <SheetHeader>
            <SheetTitle>Правила автоматизации</SheetTitle>
          </SheetHeader>
          <div className="mt-6 space-y-4">
            <Button onClick={() => setDialogOpen(true)} className="w-full">
              <Plus className="h-4 w-4 mr-2" />
              Создать правило
            </Button>
            <AutomationRuleList projectId={projectId} />
          </div>
        </SheetContent>
      </Sheet>

      <AutomationRuleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={projectId}
      />
    </>
  );
}
