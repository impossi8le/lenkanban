"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { apiFetch, apiPost } from "@/lib/api";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { SUPPORT_TEMPLATE_ID, SUPPORT_BOARD_NAME } from "@/lib/project-template-catalog";
import { createProjectSchema } from "@/lib/validators";

type DepartmentOption = { id: string; name: string; depth: number };
type GroupOption = { id: string; name: string };
type TemplateOption = { id: string; name: string; description: string | null };

export type BoardAccessMode = "all" | "departments" | "groups" | "nobody";

export type BoardAccessProfile = {
  allEmployees: boolean;
  userIds: string[];
  departmentIds: string[];
  groupIds: string[];
};

type DepartmentPage = { items: { id: string; name: string; parentId: string | null; archived: boolean }[]; nextCursor: string | null };
type GroupPage = { items: { id: string; name: string; archived: boolean }[]; nextCursor: string | null };

/** Bounded breadth-first walk; never loads an unbounded department tree. */
async function loadDepartments(signal: AbortSignal): Promise<DepartmentOption[]> {
  const result: DepartmentOption[] = [];
  const seen = new Set<string>();
  let level: { id: string; depth: number }[] = [{ id: "", depth: 0 }];
  for (let depth = 0; depth < 5 && level.length > 0 && result.length < 100; depth += 1) {
    const next: { id: string; depth: number }[] = [];
    for (const parent of level) {
      if (result.length >= 100) break;
      const query = new URLSearchParams({ archived: "active", limit: "100" });
      if (parent.id) query.set("parentId", parent.id);
      const page = await apiFetch<DepartmentPage>(`/api/admin/organization/departments?${query.toString()}`, { signal });
      for (const item of page.items) {
        if (result.length >= 100) break;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        result.push({ id: item.id, name: item.name, depth: parent.depth });
        next.push({ id: item.id, depth: parent.depth + 1 });
      }
    }
    level = next;
  }
  return result;
}

async function loadGroups(signal: AbortSignal): Promise<GroupOption[]> {
  const page = await apiFetch<GroupPage>("/api/admin/organization/groups?archived=active&limit=100", { signal });
  return page.items.map(group => ({ id: group.id, name: group.name }));
}

export function buildBoardAccessProfile(
  mode: BoardAccessMode,
  departmentIds: readonly string[],
  groupIds: readonly string[],
): BoardAccessProfile {
  if (mode === "all") return { allEmployees: true, userIds: [], departmentIds: [], groupIds: [] };
  if (mode === "departments") {
    return { allEmployees: false, userIds: [], departmentIds: [...new Set(departmentIds)].sort(), groupIds: [] };
  }
  if (mode === "groups") {
    return { allEmployees: false, userIds: [], departmentIds: [], groupIds: [...new Set(groupIds)].sort() };
  }
  return { allEmployees: false, userIds: [], departmentIds: [], groupIds: [] };
}

interface BoardCreationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTemplateId?: string | null;
}

export function BoardCreationDialog({ open, onOpenChange, initialTemplateId = null }: BoardCreationDialogProps) {
  const [departmentId, setDepartmentId] = useState("");
  const [name, setName] = useState(SUPPORT_BOARD_NAME);
  const [description, setDescription] = useState("");
  // A single preset needs no selection step.
  const templateId = SUPPORT_TEMPLATE_ID;
  void initialTemplateId;
  const [accessMode, setAccessMode] = useState<BoardAccessMode>("all");
  const [accessDepartmentIds, setAccessDepartmentIds] = useState<string[]>([]);
  const [accessGroupIds, setAccessGroupIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const router = useRouter();
  const queryClient = useQueryClient();

  const departments = useQuery({
    queryKey: ["board-creation", "departments"],
    queryFn: ({ signal }) => loadDepartments(signal),
    enabled: open,
    retry: false,
  });
  const groups = useQuery({
    queryKey: ["board-creation", "groups"],
    queryFn: ({ signal }) => loadGroups(signal),
    enabled: open,
    retry: false,
  });
  const templates = useQuery({
    queryKey: ["project-templates"],
    queryFn: ({ signal }) => apiFetch<TemplateOption[]>("/api/project-templates", { signal }),
    enabled: open,
    retry: false,
  });

  const departmentOptions = departments.data ?? [];
  const groupOptions = groups.data ?? [];
  const templateOptions = (templates.data ?? []).filter(template => template.id === SUPPORT_TEMPLATE_ID);
  const accessProfile = useMemo(
    () => buildBoardAccessProfile(accessMode, accessDepartmentIds, accessGroupIds),
    [accessMode, accessDepartmentIds, accessGroupIds],
  );

  const createMutation = useMutation({
    mutationFn: (input: { templateId: string; body: Record<string, unknown> }) => input.templateId
      ? apiPost<{ id: string }>(`/api/project-templates/${encodeURIComponent(input.templateId)}/use`, input.body)
      : apiPost<{ id: string }>("/api/projects", input.body),
    retry: false,
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success(templateId ? "Доска создана из шаблона" : "Доска создана");
      onOpenChange(false);
      resetForm();
      router.push(`/projects/${encodeURIComponent(project.id)}/board`);
    },
    onError: (failure) => {
      const rateLimited = typeof failure === "object" && failure !== null && "status" in failure && failure.status === 429;
      const message = rateLimited
        ? "Слишком много запросов. Подождите немного и попробуйте снова."
        : failure instanceof Error ? failure.message : "Не удалось создать доску";
      setError(message);
      toast.error(message);
    },
    onSettled: () => { submittingRef.current = false; },
  });

  const resetForm = () => {
    setDepartmentId("");
    setName(SUPPORT_BOARD_NAME);
    setDescription("");
    setAccessMode("all");
    setAccessDepartmentIds([]);
    setAccessGroupIds([]);
    setError(null);
  };

  const toggle = (values: string[], id: string, checked: boolean) =>
    checked ? [...values, id] : values.filter(value => value !== id);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    if (!departmentId.trim()) {
      setError("Выберите подразделение доски.");
      return;
    }
    const parsed = createProjectSchema.safeParse({ name, description: description.trim() === "" ? null : description });
    if (!parsed.success) {
      setError("Укажите название до 120 символов и описание до 10 000 символов.");
      return;
    }
    if (accessMode === "departments" && accessDepartmentIds.length === 0) {
      setError("Выберите хотя бы одно подразделение для профиля доступа.");
      return;
    }
    if (accessMode === "groups" && accessGroupIds.length === 0) {
      setError("Выберите хотя бы одну группу для профиля доступа.");
      return;
    }
    submittingRef.current = true;
    setError(null);
    const common = {
      description: parsed.data.description ?? null,
      departmentId,
      accessProfile,
    };
    createMutation.mutate({
      templateId,
      body: templateId
        ? { projectName: parsed.data.name, projectDescription: common.description, departmentId: common.departmentId, accessProfile }
        : { name: parsed.data.name, description: common.description, departmentId: common.departmentId, accessProfile },
    });
  };

  // Preview the exact profile sent to the shared server creator, including IDs
  // whose labels are unavailable after a reference-data refresh.
  const accessSummary = accessProfile.allEmployees
    ? "Все сотрудники организации."
    : accessProfile.departmentIds.length === 0 && accessProfile.groupIds.length === 0
      ? "Никто: подача заявок запрещена профилем."
      : [
        ...accessProfile.departmentIds.map(id => departmentOptions.find(option => option.id === id)?.name ?? id),
        ...accessProfile.groupIds.map(id => groupOptions.find(option => option.id === id)?.name ?? id),
      ].join(", ");

  const selectedTemplate = templateOptions.find(option => option.id === templateId) ?? null;
  const pending = createMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={next => { if (!submittingRef.current) onOpenChange(next); }}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:p-6 min-w-0 sm:max-w-2xl [overflow-wrap:anywhere]"
        onEscapeKeyDown={event => { if (submittingRef.current) event.preventDefault(); }}
        onInteractOutside={event => { if (submittingRef.current) event.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle className="break-words [overflow-wrap:anywhere]">Создать доску</DialogTitle>
          <DialogDescription className="break-words [overflow-wrap:anywhere]">
            Подразделение → название → техническая поддержка → профиль доступа → создание.
            Новые доски создают только глобальные администраторы.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-5" aria-busy={pending}>
          <fieldset className="space-y-2" disabled={pending}>
            <legend className="text-sm font-medium">1. Подразделение</legend>
            <Label htmlFor="boardDepartment">Подразделение доски</Label>
            <select
              id="boardDepartment"
              required
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={departmentId}
              onChange={event => setDepartmentId(event.target.value)}
              disabled={pending}
            >
              <option value="" disabled>Выберите подразделение</option>
              {departmentOptions.map(option => (
                <option key={option.id} value={option.id}>
                  {`${"— ".repeat(option.depth)}${option.name}`}
                </option>
              ))}
            </select>
            {departments.isError && (
              <p role="alert" className="text-sm text-destructive">Не удалось загрузить подразделения. Повторите загрузку перед созданием доски.</p>
            )}
          </fieldset>

          <fieldset className="space-y-2" disabled={pending}>
            <legend className="text-sm font-medium">2. Название</legend>
            <Label htmlFor="boardName">Название доски</Label>
            <Input
              id="boardName"
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="Техническая поддержка"
              required
              maxLength={120}
              disabled={pending}
            />
            <Label htmlFor="boardDescription">Описание</Label>
            <Textarea
              id="boardDescription"
              value={description}
              onChange={event => setDescription(event.target.value)}
              rows={2}
              maxLength={10000}
              disabled={pending}
            />
          </fieldset>

          <fieldset className="space-y-2" disabled={pending}>
            <legend className="text-sm font-medium">3. Основа доски</legend>
            <p className="text-sm font-medium">Техническая поддержка</p>
            <p className="text-sm text-muted-foreground">
              {selectedTemplate
                ? `Из шаблона «${selectedTemplate.name}» переносятся только колонки и теги: участники, права и карточки не копируются.`
                : "Новая → В работе → Ожидает ответа → Решена → Закрыта."}
            </p>
            {templates.isError && (
              <p role="alert" className="text-sm text-destructive">Не удалось загрузить сведения о шаблоне. Используется стандартный маршрут технической поддержки.</p>
            )}
          </fieldset>

          <fieldset className="space-y-2" disabled={pending}>
            <legend className="text-sm font-medium">4. Профиль доступа</legend>
            <div className="space-y-2">
              {([
                { value: "all", label: "Все сотрудники" },
                { value: "departments", label: "Сотрудники выбранных подразделений" },
                { value: "groups", label: "Участники выбранных групп" },
                { value: "nobody", label: "Никто (настроить позже)" },
              ] as const).map(option => (
                <label key={option.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="accessMode"
                    value={option.value}
                    checked={accessMode === option.value}
                    onChange={() => setAccessMode(option.value)}
                    disabled={pending}
                  />
                  {option.label}
                </label>
              ))}
            </div>

            {accessMode === "departments" && (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                {departmentOptions.length === 0
                  ? <p className="text-sm text-muted-foreground">Нет доступных подразделений.</p>
                  : departmentOptions.map(option => (
                    <label key={option.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={accessDepartmentIds.includes(option.id)}
                        onCheckedChange={checked => setAccessDepartmentIds(values => toggle(values, option.id, checked === true))}
                        disabled={pending}
                        aria-label={`Подразделение ${option.name}`}
                      />
                      {option.name}
                    </label>
                  ))}
              </div>
            )}

            {accessMode === "groups" && (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                {groupOptions.length === 0
                  ? <p className="text-sm text-muted-foreground">Нет доступных групп.</p>
                  : groupOptions.map(option => (
                    <label key={option.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={accessGroupIds.includes(option.id)}
                        onCheckedChange={checked => setAccessGroupIds(values => toggle(values, option.id, checked === true))}
                        disabled={pending}
                        aria-label={`Группа ${option.name}`}
                      />
                      {option.name}
                    </label>
                  ))}
              </div>
            )}
            {groups.isError && accessMode === "groups" && (
              <p role="alert" className="text-sm text-destructive">Не удалось загрузить группы.</p>
            )}
          </fieldset>

          <section aria-labelledby="board-access-preview" className="rounded-md border bg-muted/30 p-3">
            <h3 id="board-access-preview" className="text-sm font-medium">Кто получит доступ к подаче заявок</h3>
            <p className="mt-1 text-sm break-words [overflow-wrap:anywhere]" data-testid="access-preview">{accessSummary}</p>
            <p className="mt-1 text-xs text-muted-foreground break-words [overflow-wrap:anywhere]">
              Владелец доски — вы. Владение доской не добавляет вас в профиль доступа автоматически,
              а участники, права и карточки шаблона не копируются. Профиль разрешает только подачу заявок:
              он не открывает чужие заявки и не даёт права менять их или управлять доской.
            </p>
          </section>

          {pending && <p role="status" className="text-sm text-muted-foreground">Создаём доску. Дождитесь результата перед закрытием формы.</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-2">
            <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={pending} onClick={() => { if (!submittingRef.current) onOpenChange(false); }}>
              Отмена
            </Button>
            <Button type="submit" className="w-full sm:w-auto" disabled={pending || !name.trim() || !departmentId}>
              {pending ? "Создание..." : "Создать доску"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
