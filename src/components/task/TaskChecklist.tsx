"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Plus, X, Check, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { apiPost, apiPatch, apiDelete } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { getBrowserTelemetryClient } from "@/lib/telemetry/client";

type ChecklistItem = {
  id: string;
  taskId: string;
  text: string;
  completed: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
};

type Props = {
  taskId: string;
  items: ChecklistItem[];
  onUpdate: (items: ChecklistItem[]) => void;
};

export function TaskChecklist({ taskId, items, onUpdate }: Props) {
  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(false);
  const [newItemText, setNewItemText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isMutating, setIsMutating] = useState(false);
  const pendingMutation = useRef(false);
  const itemRefs = useRef<Map<string, HTMLInputElement | HTMLDivElement>>(new Map());
  const editInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const setItemRef = useCallback((itemId: string) => (el: HTMLInputElement | HTMLDivElement | null) => {
    if (el) {
      itemRefs.current.set(itemId, el);
    } else {
      itemRefs.current.delete(itemId);
    }
  }, []);

  const setEditInputRef = useCallback((itemId: string) => (el: HTMLInputElement | null) => {
    if (el) {
      editInputRefs.current.set(itemId, el);
    } else {
      editInputRefs.current.delete(itemId);
    }
  }, []);

  // Focus edit input when entering edit mode
  useEffect(() => {
    if (editingId) {
      const input = editInputRefs.current.get(editingId);
      input?.focus();
      input?.select();
    }
  }, [editingId]);

  // Get sorted item IDs for keyboard navigation
  const sortedItemIds = items.map(item => item.id);

  const addItem = useCallback(async () => {
    if (!newItemText.trim() || pendingMutation.current) return;
    pendingMutation.current = true;
    setIsMutating(true);

    setErrorMessage(null);
    try {
      const created = await apiPost<ChecklistItem>(`/api/tasks/${taskId}/checklist`, {
        text: newItemText.trim(),
      });

      onUpdate([...items, created]);
      queryClient.invalidateQueries({ queryKey: ["activities", taskId] });
      setNewItemText("");
      setIsAdding(false);
    } catch {
      setErrorMessage("Не удалось добавить пункт. Повторите попытку.");
    } finally {
      pendingMutation.current = false;
      setIsMutating(false);
    }
  }, [taskId, newItemText, items, onUpdate, queryClient]);

  const toggleItem = useCallback(
    async (itemId: string, completed: boolean) => {
      if (pendingMutation.current) return;
      pendingMutation.current = true;
      setIsMutating(true);
      setErrorMessage(null);
      try {
        const client = getBrowserTelemetryClient();
        const action = client?.beginAction();
        const actionId = action?.actionId ?? globalThis.crypto?.randomUUID?.();
        const operationId = action?.operationId ?? globalThis.crypto?.randomUUID?.();
        const updated = await apiPatch<ChecklistItem>(
          `/api/tasks/${taskId}/checklist/${itemId}`,
          { completed },
          actionId && operationId ? {
            actionId, operationId,
            onResult: (result) => { if (action) client?.finishAction(action, result); },
          } : undefined,
        );
        onUpdate(items.map((item) => (item.id === itemId ? updated : item)));
        queryClient.invalidateQueries({ queryKey: ["activities", taskId] });
      } catch {
        setErrorMessage("Не удалось изменить пункт. Повторите попытку.");
      } finally {
        pendingMutation.current = false;
        setIsMutating(false);
      }
    },
    [taskId, items, onUpdate, queryClient]
  );

  const updateItemText = useCallback(
    async (itemId: string, text: string) => {
      if (!text.trim() || pendingMutation.current) return;
      pendingMutation.current = true;
      setIsMutating(true);
      setErrorMessage(null);
      try {
        const updated = await apiPatch<ChecklistItem>(
          `/api/tasks/${taskId}/checklist/${itemId}`,
          { text: text.trim() }
        );

        onUpdate(items.map((item) => (item.id === itemId ? updated : item)));
        queryClient.invalidateQueries({ queryKey: ["activities", taskId] });
        setEditingId(null);
        setEditingText("");
      } catch {
        setErrorMessage("Не удалось изменить текст пункта. Повторите попытку.");
      } finally {
        pendingMutation.current = false;
        setIsMutating(false);
      }
    },
    [taskId, items, onUpdate, queryClient]
  );

  const deleteItem = useCallback(
    async (itemId: string) => {
      if (pendingMutation.current) return;
      pendingMutation.current = true;
      setIsMutating(true);
      setErrorMessage(null);
      try {
        await apiDelete(`/api/tasks/${taskId}/checklist/${itemId}`);
        onUpdate(items.filter((item) => item.id !== itemId));
        queryClient.invalidateQueries({ queryKey: ["activities", taskId] });
      } catch {
        setErrorMessage("Не удалось удалить пункт. Повторите попытку.");
      } finally {
        pendingMutation.current = false;
        setIsMutating(false);
      }
    },
    [taskId, items, onUpdate, queryClient]
  );

  // Keyboard navigation helpers
  const focusItem = useCallback((itemId: string) => {
    const element = itemRefs.current.get(itemId);
    element?.focus();
  }, []);

  const navigateItems = useCallback((currentId: string, direction: 'up' | 'down') => {
    const currentIndex = sortedItemIds.indexOf(currentId);
    if (currentIndex === -1) return;

    const newIndex = direction === 'up'
      ? Math.max(0, currentIndex - 1)
      : Math.min(sortedItemIds.length - 1, currentIndex + 1);

    const newId = sortedItemIds[newIndex];
    if (newId && newId !== currentId) {
      focusItem(newId);
    }
  }, [sortedItemIds, focusItem]);

  const completedCount = items.filter((item) => item.completed).length;
  const totalCount = items.length;
  const progress = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  return (
    <div className="min-w-0 space-y-3" aria-busy={isMutating}>
      {errorMessage && <p role="alert" className="text-sm text-destructive">{errorMessage}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">
          Чек-лист
          {totalCount > 0 && (
            <span className="ml-2 text-xs text-muted-foreground">
              {completedCount}/{totalCount}
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIsAdding(true)}
          disabled={isAdding || isMutating}
        >
          <Plus className="h-4 w-4 mr-2" />
          Добавить пункт
        </Button>
      </div>

      {totalCount > 0 && (
        <div className="space-y-1">
          <div className="h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="text-xs text-muted-foreground text-right">
            Выполнено {Math.round(progress)}%
          </div>
        </div>
      )}

      <div className="space-y-2">
        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              "flex min-w-0 items-start gap-2 p-2 rounded border group",
              item.completed && "bg-muted/50"
            )}
          >
            <Checkbox
              checked={item.completed}
              disabled={isMutating}
              aria-label={`Отметить пункт: ${item.text}`}
              onCheckedChange={(checked) => toggleItem(item.id, checked === true)}
              className="mt-0.5 flex-shrink-0"
            />

            {editingId === item.id ? (
              <div className="min-w-0 flex-1 flex items-center gap-2">
                <input
                  disabled={isMutating}
                  ref={setEditInputRef(item.id)}
                  value={editingText}
                  onChange={(e) => setEditingText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      updateItemText(item.id, editingText);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setEditingId(null);
                      setEditingText("");
                      focusItem(item.id);
                    }
                  }}
                  className="min-w-0 flex-1 h-9 px-2 rounded border bg-background text-sm outline-none"
                  aria-label="Текст пункта"
                />
                <Button
                  disabled={isMutating}
                  size="icon"
                  variant="ghost"
                  className="h-9 w-9 shrink-0"
                  onClick={() => updateItemText(item.id, editingText)}
                  aria-label="Сохранить"
                >
                  <Check className="h-4 w-4" />
                </Button>
                <Button
                  disabled={isMutating}
                  size="icon"
                  variant="ghost"
                  className="h-9 w-9 shrink-0"
                  onClick={() => {
                    setEditingId(null);
                    setEditingText("");
                  }}
                  aria-label="Отменить"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <>
                <div
                  ref={setItemRef(item.id)}
                  className={cn(
                    "min-w-0 flex-1 text-sm cursor-pointer [overflow-wrap:anywhere]",
                    item.completed && "line-through text-muted-foreground"
                  )}
                  onClick={() => toggleItem(item.id, !item.completed)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleItem(item.id, !item.completed);
                    } else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      navigateItems(item.id, 'down');
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      navigateItems(item.id, 'up');
                    } else if ((e.key === "e" || e.key === "E") && !pendingMutation.current) {
                      e.preventDefault();
                      setEditingId(item.id);
                      setEditingText(item.text);
                    }
                  }}
                  tabIndex={0}
                  role="checkbox"
                  aria-checked={item.completed}
                  aria-disabled={isMutating}
                >
                  {item.text}
                </div>
                <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity flex-shrink-0">
                  <Button
                    disabled={isMutating}
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9"
                    onClick={() => {
                      setEditingId(item.id);
                      setEditingText(item.text);
                    }}
                    aria-label="Редактировать"
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    disabled={isMutating}
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9"
                    onClick={() => deleteItem(item.id)}
                    aria-label="Удалить"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {isAdding && (
        <div className="flex min-w-0 items-center gap-2 p-2 rounded border">
          <Checkbox disabled className="flex-shrink-0" />
          <input
            disabled={isMutating}
            value={newItemText}
            onChange={(e) => setNewItemText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addItem();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setIsAdding(false);
                setNewItemText("");
                // Focus the last item or the "Add item" button
                if (items.length > 0) {
                  focusItem(items[items.length - 1].id);
                }
              }
            }}
            placeholder="Текст пункта..."
            className="min-w-0 flex-1 h-9 px-2 rounded border bg-background text-sm outline-none"
            aria-label="Новый пункт чек-листа"
            autoFocus
          />
          <Button disabled={isMutating} size="icon" variant="ghost" className="h-9 w-9 shrink-0" onClick={addItem} aria-label="Добавить элемент">
            <Check className="h-4 w-4" />
          </Button>
          <Button
            disabled={isMutating}
            size="icon"
            variant="ghost"
            className="h-9 w-9 shrink-0"
            onClick={() => {
              setIsAdding(false);
              setNewItemText("");
            }}
            aria-label="Отменить"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {items.length === 0 && !isAdding && (
        <div className="text-xs text-muted-foreground py-4 text-center border border-dashed rounded">
          В чек-листе пока нет пунктов
        </div>
      )}
    </div>
  );
}
