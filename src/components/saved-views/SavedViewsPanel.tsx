"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Plus, Eye, Trash2, Star, StarOff, Tag } from "lucide-react";
import { apiFetch, apiPost, apiPatch, apiDelete } from "@/lib/api";

interface SavedView {
  id: string;
  name: string;
  description: string | null;
  projectId: string;
  viewType: string;
  filters: {
    status?: string | null;
    priority?: string | null;
    assignee?: string | null;
    tags?: string[] | null;
    search?: string;
  };
  sortBy: string;
  isDefault: boolean;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

interface SavedViewsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  currentFilters?: {
    status: string | null;
    priority: string | null;
    assignee: string | null;
    tags: string[] | null;
    search?: string;
  };
  currentSortBy?: string;
  currentViewType: string;
  onLoadView: (view: SavedView) => void;
}

export function SavedViewsPanel({
  open,
  onOpenChange,
  projectId,
  currentFilters,
  currentSortBy,
  currentViewType,
  onLoadView,
}: SavedViewsPanelProps) {
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  const [newViewDescription, setNewViewDescription] = useState("");
  const [newViewIsDefault, setNewViewIsDefault] = useState(false);

  // Fetch saved views
  const { data: savedViews, isLoading } = useQuery({
    queryKey: ["saved-views", projectId],
    queryFn: ({ signal }) => apiFetch<SavedView[]>(`/api/saved-views?projectId=${projectId}`, { signal }),
    enabled: open,
  });

  // Create saved view mutation
  const createMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description?: string;
      projectId: string;
      viewType: string;
      filters: SavedView["filters"];
      sortBy: string;
      isDefault: boolean;
    }) => apiPost<SavedView>("/api/saved-views", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["saved-views", projectId] });
      toast.success("Представление сохранено");
      setShowCreateForm(false);
      setNewViewName("");
      setNewViewDescription("");
      setNewViewIsDefault(false);
    },
    onError: (error) => {
      toast.error("Не удалось сохранить представление", {
        description: error.message,
      });
    },
  });

  // Update saved view mutation
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<SavedView> }) =>
      apiPatch<SavedView>(`/api/saved-views/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["saved-views", projectId] });
      toast.success("Представление обновлено");
    },
    onError: (error) => {
      toast.error("Не удалось обновить представление", {
        description: error.message,
      });
    },
  });

  // Delete saved view mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/saved-views/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["saved-views", projectId] });
      toast.success("Представление удалено");
    },
    onError: (error) => {
      toast.error("Не удалось удалить представление", {
        description: error.message,
      });
    },
  });

  const handleCreateView = () => {
    if (!newViewName.trim()) {
      toast.error("Введите название представления");
      return;
    }

    createMutation.mutate({
      name: newViewName,
      description: newViewDescription || undefined,
      projectId,
      viewType: currentViewType,
      filters: currentFilters || { status: null, priority: null, assignee: null, tags: null },
      sortBy: currentSortBy || "position",
      isDefault: newViewIsDefault,
    });
  };

  const handleToggleDefault = (view: SavedView) => {
    updateMutation.mutate({
      id: view.id,
      data: { isDefault: !view.isDefault },
    });
  };

  const handleDeleteView = (id: string) => {
    if (confirm("Вы уверены, что хотите удалить это представление?")) {
      deleteMutation.mutate(id);
    }
  };

  const hasActiveFilters =
    (currentFilters?.status ||
    currentFilters?.priority ||
    currentFilters?.assignee ||
    currentFilters?.search ||
    (currentFilters?.tags && currentFilters.tags.length > 0) ||
    (currentSortBy && currentSortBy !== "position")) ?? false;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full max-w-full overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:max-w-[540px] [&_button]:min-h-11 [&_input]:min-h-11 [&>button]:min-w-11">
        <SheetHeader className="min-w-0 break-words pr-10">
          <SheetTitle>Сохраненные представления</SheetTitle>
          <SheetDescription>
            Сохраняйте текущие фильтры и сортировку для быстрого доступа
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4">
          {/* Save current view button */}
          {!showCreateForm && (
            <Button
              onClick={() => setShowCreateForm(true)}
              className="h-auto w-full whitespace-normal py-2"
              variant="outline"
              disabled={!hasActiveFilters}
            >
              <Plus className="mr-2 h-4 w-4" />
              Сохранить текущее представление
            </Button>
          )}

          {!hasActiveFilters && !showCreateForm && (
            <p className="text-sm text-muted-foreground text-center">
              Примените фильтры или сортировку, чтобы сохранить представление
            </p>
          )}

          {/* Create form */}
          {showCreateForm && (
            <div className="space-y-4 p-4 border rounded-lg">
              <div className="space-y-2">
                <Label htmlFor="view-name">Название</Label>
                <Input
                  id="view-name"
                  value={newViewName}
                  onChange={(e) => setNewViewName(e.target.value)}
                  placeholder="Мои задачи"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="view-description">Описание (опционально)</Label>
                <Textarea
                  id="view-description"
                  value={newViewDescription}
                  onChange={(e) => setNewViewDescription(e.target.value)}
                  placeholder="Задачи с высоким приоритетом, назначенные мне"
                  rows={2}
                />
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="view-default"
                  checked={newViewIsDefault}
                  onCheckedChange={(checked) => setNewViewIsDefault(checked as boolean)}
                />
                <Label htmlFor="view-default" className="text-sm font-normal">
                  Использовать по умолчанию
                </Label>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  onClick={handleCreateView}
                  disabled={createMutation.isPending}
                  className="flex-1"
                >
                  Сохранить
                </Button>
                <Button
                  onClick={() => {
                    setShowCreateForm(false);
                    setNewViewName("");
                    setNewViewDescription("");
                    setNewViewIsDefault(false);
                  }}
                  variant="outline"
                  className="flex-1"
                >
                  Отмена
                </Button>
              </div>
            </div>
          )}

          {/* Saved views list */}
          <div className="space-y-2">
            <Label>Сохраненные представления</Label>
            <ScrollArea className="h-[min(400px,calc(100dvh-16rem))]">
              {isLoading && (
                <div role="status" aria-live="polite" className="text-sm text-muted-foreground text-center py-8">
                  Загрузка...
                </div>
              )}

              {!isLoading && (!savedViews || savedViews.length === 0) && (
                <div className="text-sm text-muted-foreground text-center py-8">
                  Нет сохраненных представлений
                </div>
              )}

              {savedViews && savedViews.length > 0 && (
                <div className="space-y-2">
                  {savedViews.map((view) => (
                    <div
                      key={view.id}
                      className="p-3 border rounded-lg hover:bg-accent transition-colors"
                    >
                      <div className="flex min-w-0 flex-col items-stretch justify-between gap-2 sm:flex-row sm:items-start">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="min-w-0 font-medium text-sm [overflow-wrap:anywhere]">
                              {view.name}
                            </h4>
                            {view.isDefault && (
                              <Star className="h-3 w-3 fill-yellow-500 text-yellow-500" />
                            )}
                          </div>
                          {view.description && (
                            <p className="text-xs text-muted-foreground mt-1 [overflow-wrap:anywhere]">
                              {view.description}
                            </p>
                          )}
                          <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                            <span className="capitalize">{view.viewType}</span>
                            <span>•</span>
                            <span>{view.sortBy}</span>
                          </div>
                          {(view.filters?.status ||
                            view.filters?.priority ||
                            view.filters?.assignee ||
                            (view.filters?.tags && view.filters.tags.length > 0)) && (
                            <div className="flex flex-wrap items-center gap-1.5 mt-2">
                              {view.filters?.status && (
                                <Badge variant="outline" className="text-xs font-normal">
                                  {view.filters.status}
                                </Badge>
                              )}
                              {view.filters?.priority && (
                                <Badge variant="outline" className="text-xs font-normal">
                                  {view.filters.priority}
                                </Badge>
                              )}
                              {view.filters?.assignee && (
                                <Badge variant="outline" className="text-xs font-normal">
                                  {view.filters.assignee === "unassigned"
                                    ? "Без исполнителя"
                                    : view.filters.assignee}
                                </Badge>
                              )}
                              {view.filters?.tags && view.filters.tags.length > 0 && (
                                <Badge variant="outline" className="text-xs font-normal gap-1">
                                  <Tag className="h-3 w-3" />
                                  {view.filters.tags.length}
                                </Badge>
                              )}
                            </div>
                          )}
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-1 [&_button]:min-w-11">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onLoadView(view)}
                            title="Загрузить представление"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleToggleDefault(view)}
                            title={
                              view.isDefault
                                ? "Убрать из избранного"
                                : "Добавить в избранное"
                            }
                          >
                            {view.isDefault ? (
                              <StarOff className="h-4 w-4" />
                            ) : (
                              <Star className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDeleteView(view.id)}
                            title="Удалить представление"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
