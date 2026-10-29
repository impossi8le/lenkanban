"use client";

import { BoardCreationDialog } from "./BoardCreationDialog";

interface UseTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateId: string | null;
}

/**
 * Compatibility entry point for "create from this template". It renders the one
 * shared board-creation scenario with the template preselected, so department,
 * access profile and preview behave exactly as for an empty board.
 */
export function UseTemplateDialog({ open, onOpenChange, templateId }: UseTemplateDialogProps) {
  return (
    <BoardCreationDialog
      key={templateId ?? "empty"}
      open={open}
      onOpenChange={onOpenChange}
      initialTemplateId={templateId}
    />
  );
}
