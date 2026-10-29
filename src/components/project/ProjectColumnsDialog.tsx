"use client";

import { useState, useRef, useEffect } from "react";
import { lifecycleColumnFields, lifecycleWorkflowKeys, type LifecycleColumnMap } from "@/lib/task-request-columns";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch, apiPatch, apiPost, apiDelete } from "@/lib/api";
import { Columns, Plus, Trash2, GripVertical } from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  Modifiers,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToWindowEdges } from "@dnd-kit/modifiers";

interface ProjectColumn {
  id: string;
  projectId: string;
  name: string;
  color: string;
  position: number;
  workflowKey?: string;
}

interface ProjectColumnsDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function SortableColumn({
  column,
  editingColumn,
  editName,
  editColor,
  onEditStart,
  onUpdate,
  onDelete,
  onEditNameChange,
  onEditColorChange,
  columnsLength,
}: {
  column: ProjectColumn;
  editingColumn: string | null;
  editName: string;
  editColor: string;
  onEditStart: (column: ProjectColumn) => void;
  onUpdate: (columnId: string) => void;
  onDelete: (columnId: string) => void;
  onEditNameChange: (value: string) => void;
  onEditColorChange: (value: string) => void;
  columnsLength: number;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: column.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    cursor: isDragging ? 'grabbing' : 'grab',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 p-3 border rounded-lg bg-card min-w-0"
    >
      <button
        type="button"
        className="cursor-grab active:cursor-grabbing hover:bg-accent rounded p-1 transition-colors shrink-0"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4 text-muted-foreground" />
      </button>

      {editingColumn === column.id ? (
        <div className="flex flex-1 min-w-0 flex-wrap sm:flex-nowrap items-center gap-2">
          <Input
            value={editName}
            onChange={(e) => onEditNameChange(e.target.value)}
            placeholder="Название колонки"
            className="flex-1 min-w-[120px]"
            maxLength={50}
          />
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="color"
              value={editColor}
              onChange={(e) => onEditColorChange(e.target.value)}
              className="w-10 sm:w-12 h-9 rounded border cursor-pointer"
            />
            <Button
              size="sm"
              onClick={() => onUpdate(column.id)}
              disabled={!editName.trim()}
            >
              Сохранить
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onEditNameChange("");
                onEditColorChange("");
              }}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div
            className="w-4 h-4 rounded shrink-0"
            style={{ backgroundColor: column.color }}
          />
          <span className="flex-1 min-w-0 font-medium truncate break-words">{column.name}</span>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onEditStart(column)}
            >
              Изменить
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDelete(column.id)}
              disabled={columnsLength <= 1}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function ProjectColumnsDialog({
  projectId,
  open,
  onOpenChange,
}: ProjectColumnsDialogProps) {
  const queryClient = useQueryClient();
  const [editingColumn, setEditingColumn] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#3b82f6");
  const [lifecycleBlocked, setLifecycleBlocked] = useState(false);

  // Fetch columns
  const { data: columns, isLoading, error } = useQuery({
    queryKey: ["columns", projectId],
    queryFn: ({ signal }) => apiFetch<ProjectColumn[]>(`/api/projects/${projectId}/columns`, { signal }),
    enabled: open,
  });

  // Log error for debugging
  if (error) {
    console.error("[ProjectColumnsDialog] Failed to load columns:", error);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // Only start dragging after moving 5px
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const modifiers: Modifiers = [
    restrictToVerticalAxis,
    restrictToWindowEdges,
  ];

  const reorderColumnsMutation = useMutation({
    mutationFn: (columnIds: string[]) =>
      apiPatch(`/api/projects/${projectId}/columns/reorder`, { columnIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["columns", projectId] });
      toast.success("Порядок колонок изменен", {
        description: "Колонки успешно переставлены",
      });
    },
    onError: () => {
      toast.error("Не удалось изменить порядок колонок", {
        description: "Попробуйте еще раз",
      });
    },
  });

  const createColumnMutation = useMutation({
    mutationFn: (data: { name: string; color: string }) => {
      return apiPost(`/api/projects/${projectId}/columns`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["columns", projectId] });
      setIsAddingNew(false);
      setNewName("");
      setNewColor("#3b82f6");
      toast.success("Колонка создана", {
        description: "Новая колонка добавлена в проект",
      });
    },
    onError: (error) => {
      console.error('[ProjectColumnsDialog] Failed to create column:', error);
      toast.error("Не удалось создать колонку", {
        description: "Попробуйте еще раз",
      });
    },
  });

  const updateColumnMutation = useMutation({
    mutationFn: ({ columnId, data }: { columnId: string; data: { name?: string; color?: string } }) =>
      apiPatch(`/api/projects/${projectId}/columns/${columnId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["columns", projectId] });
      setEditingColumn(null);
      toast.success("Колонка обновлена", {
        description: "Изменения сохранены успешно",
      });
    },
    onError: () => {
      toast.error("Не удалось обновить колонку", {
        description: "Попробуйте еще раз",
      });
    },
  });

  const deleteColumnMutation = useMutation({
    mutationFn: (columnId: string) =>
      apiDelete(`/api/projects/${projectId}/columns/${columnId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["columns", projectId] });
      toast.success("Колонка удалена", {
        description: "Колонка успешно удалена",
      });
    },
    onError: (error) => {
      toast.error("Не удалось удалить колонку", {
        description: error?.message || "Попробуйте еще раз",
      });
    },
  });

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = columns!.findIndex((c) => c.id === active.id);
      const newIndex = columns!.findIndex((c) => c.id === over.id);

      const newColumns = arrayMove(columns!, oldIndex, newIndex);
      const columnIds = newColumns.map((c) => c.id);

      reorderColumnsMutation.mutate(columnIds);
    }
  };

  const handleCreateColumn = () => {
    if (!newName.trim()) return;
    createColumnMutation.mutate({
      name: newName.trim(),
      color: newColor,
    });
  };

  const handleUpdateColumn = (columnId: string) => {
    if (!editName.trim()) return;
    updateColumnMutation.mutate({
      columnId,
      data: {
        name: editName.trim(),
        color: editColor,
      },
    });
  };

  const handleDeleteColumn = (columnId: string) => {
    if (confirm("Вы уверены, что хотите удалить эту колонку?")) {
      deleteColumnMutation.mutate(columnId);
    }
  };

  const startEditing = (column: ProjectColumn) => {
    setEditingColumn(column.id);
    setEditName(column.name);
    setEditColor(column.color);
  };

  return (
    <Dialog open={open} onOpenChange={value => { if (!lifecycleBlocked) onOpenChange(value); }}>
      <DialogContent className="max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:p-6 min-w-0 [overflow-wrap:anywhere]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Columns className="h-5 w-5" />
            Управление колонками
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-muted-foreground">Загрузка...</div>
        ) : columns && columns.length > 0 ? (
          <div className="space-y-4 min-w-0">
            <p className="text-sm text-muted-foreground">
              Перетаскивайте колонки чтобы изменить их порядок. Нажмите на колонку чтобы изменить её название или цвет.
            </p>
            <LifecycleColumnSettings key={projectId} projectId={projectId} columns={columns} onBlocked={setLifecycleBlocked} />

            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
              modifiers={modifiers}
            >
              <SortableContext
                items={columns.map((c) => c.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-2 min-w-0">
                  {columns.map((column) => (
                    <SortableColumn
                      key={column.id}
                      column={column}
                      editingColumn={editingColumn}
                      editName={editName}
                      editColor={editColor}
                      onEditStart={startEditing}
                      onUpdate={handleUpdateColumn}
                      onDelete={handleDeleteColumn}
                      onEditNameChange={setEditName}
                      onEditColorChange={setEditColor}
                      columnsLength={columns.length}
                    />
                  ))}

                  {isAddingNew && (
                    <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 p-3 border rounded-lg bg-card border-primary min-w-0">
                      <div className="flex items-center gap-2 flex-1 min-w-[140px]">
                        <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <Input
                          value={newName}
                          onChange={(e) => setNewName(e.target.value)}
                          placeholder="Название новой колонки"
                          className="flex-1 min-w-0"
                          maxLength={50}
                          autoFocus
                        />
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <input
                          type="color"
                          value={newColor}
                          onChange={(e) => setNewColor(e.target.value)}
                          className="w-10 sm:w-12 h-9 rounded border cursor-pointer"
                        />
                        <Button
                          size="sm"
                          onClick={handleCreateColumn}
                          disabled={!newName.trim() || createColumnMutation.isPending}
                        >
                          Создать
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setIsAddingNew(false);
                            setNewName("");
                            setNewColor("#3b82f6");
                          }}
                        >
                          Отмена
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </SortableContext>
            </DndContext>

            {!isAddingNew && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  setIsAddingNew(true);
                }}
              >
                <Plus className="h-4 w-4 mr-2" />
                Добавить колонку
              </Button>
            )}
          </div>
        ) : (
          <div className="py-8 text-center text-muted-foreground">
            Нет колонок. Добавьте первую колонку.
          </div>
        )}

        <div className="flex justify-end mt-4 pt-4 border-t">
          <Button variant="outline" disabled={lifecycleBlocked} className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>
            Закрыть
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const lifecycleLabels = ["Новая", "В работе", "Ожидает ответа", "Решена", "Закрыта"];
function LifecycleColumnSettings({ projectId, columns, onBlocked }: { projectId: string; columns: ProjectColumn[]; onBlocked: (blocked: boolean) => void }) {
  const query = useQuery({ queryKey: ["lifecycle-columns", projectId], queryFn: ({ signal }) => apiFetch<{ lifecycleColumnMap: LifecycleColumnMap | null; version: number }>(`/api/projects/${projectId}/columns?lifecycle=1`, { signal }), retry: false });
  const [selection, setSelection] = useState<Partial<Record<typeof lifecycleColumnFields[number], string>>>({});
  const [phase, setPhase] = useState<"idle" | "pending" | "unknown" | "conflict" | "saved">("idle");
  const intent = useRef<{ operationId: string; expectedVersion: number; lifecycleColumnMap: LifecycleColumnMap } | null>(null);
  const pending = useRef(false);
  useEffect(() => { onBlocked(phase === "pending" || phase === "unknown"); }, [phase, onBlocked]);
  // The endpoint is ADMIN-only and rechecks the fresh role. Ordinary column
  // editors never get lifecycle settings from a cached session role.
  if (phase === "idle" && (query.isError || typeof query.data?.version !== "number")) return null;
  const valueFor = (key: typeof lifecycleColumnFields[number]) => selection[key] ?? query.data?.lifecycleColumnMap?.[key] ?? "";
  const values = lifecycleColumnFields.map(valueFor);
  const valid = values.every(Boolean) && new Set(values).size === 5;
  const send = async () => {
    if (pending.current) return;
    if (!intent.current) {
      if (!valid || !query.data) return;
      intent.current = { operationId: crypto.randomUUID(), expectedVersion: query.data.version, lifecycleColumnMap: { contractVersion: 1,
        submittedColumnId: values[0], inProgressColumnId: values[1], needsInfoColumnId: values[2], completedColumnId: values[3], closedColumnId: values[4] } };
    }
    pending.current = true; setPhase("pending");
    try {
      await apiFetch(`/api/projects/${projectId}/columns`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(intent.current) });
      // Committed means retries are reads only, even if refresh fails.
      intent.current = null; setPhase("saved");
      await query.refetch();
    } catch (error) {
      const status = (error as { status?: number }).status;
      setPhase(status !== undefined && [400, 401, 403, 404, 409, 413, 422, 429].includes(status) ? "conflict" : "unknown");
    } finally { pending.current = false; }
  };
  const reload = async () => {
    if (pending.current) return;
    pending.current = true;
    try { const result = await query.refetch(); if (!result.isError) { intent.current = null; setSelection({}); setPhase("idle"); } }
    finally { pending.current = false; }
  };
  return <fieldset className="space-y-3 rounded-md border p-3 min-w-0">
    <legend className="px-1 font-medium">Маршрут заявок</legend>
    <p className="text-sm text-muted-foreground">Выберите пять разных колонок. Настроенный маршрут нельзя менять при наличии заявок. Колонка «Закрыта» должна быть завершающей.</p>
    {query.isError && <p role="alert">Не удалось загрузить актуальный маршрут. Повторите чтение или закройте настройки после отклонённого изменения.</p>}
    {lifecycleColumnFields.map((key, index) => <label key={key} className="grid gap-1 text-sm">{lifecycleLabels[index]}<select disabled={phase !== "idle"} className="min-w-0 w-full rounded border bg-background p-2" value={valueFor(key)} onChange={event => setSelection(current => ({ ...current, [key]: event.target.value }))}><option value="">Выберите колонку</option>{columns.filter(column => column.workflowKey === undefined || (lifecycleWorkflowKeys[key] ? column.workflowKey === lifecycleWorkflowKeys[key] : column.workflowKey !== "DONE")).map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>)}
    <Button type="button" disabled={!valid || phase !== "idle"} onClick={() => void send()}>Сохранить маршрут</Button>
    {phase === "pending" && <p role="status">Сохраняем маршрут…</p>}
    {phase !== "idle" && phase !== "pending" && <div role="alert"><p>{phase === "saved" ? "Маршрут сохранён. Обновите данные перед новым изменением." : phase === "conflict" ? "Маршрут не изменён: проверьте права, выбранные колонки и наличие заявок. Загрузите актуальные данные." : "Результат неизвестен. Повтор отправит ту же команду."}</p></div>}
    {phase === "unknown" && <Button disabled={false} type="button" onClick={() => void send()}>Повторить ту же команду</Button>}
    {(phase === "saved" || phase === "conflict") && <Button disabled={false} type="button" onClick={() => void reload()}>Загрузить маршрут</Button>}
  </fieldset>;
}
