"use client";
import {SearchHighlight} from "@/components/ui/SearchHighlight";

import * as React from "react";
import { Check, Plus, Tag as TagIcon, X } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { TagBadge } from "./TagBadge";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";

interface Tag {
  id: string;
  name: string;
  color: string;
}

interface TagPickerProps {
  projectId: string;
  taskId: string;
  selectedTags: Array<{ tag: Tag }>;
  onTagsChange?: (tags: Array<{ tag: Tag }>) => void;
}

const PRESET_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#f59e0b", // amber
  "#84cc16", // lime
  "#10b981", // emerald
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#0ea5e9", // sky
  "#ec4899", // pink
  "#64748b", // slate
];

export function TagPicker({ projectId, taskId, selectedTags, onTagsChange }: TagPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [search,setSearch] = React.useState("");
  const [showCreateForm, setShowCreateForm] = React.useState(false);
  const [newTagName, setNewTagName] = React.useState("");
  const [newTagColor, setNewTagColor] = React.useState(PRESET_COLORS[0]);
  const tagNameId = React.useId();
  const tagNameInputRef = React.useRef<HTMLInputElement>(null);
  const createButtonRef = React.useRef<HTMLButtonElement>(null);
  const wasCreateFormOpen = React.useRef(false);
  React.useEffect(() => {
    if (showCreateForm) {
      tagNameInputRef.current?.focus();
      wasCreateFormOpen.current = true;
    } else if (wasCreateFormOpen.current) {
      createButtonRef.current?.focus();
      wasCreateFormOpen.current = false;
    }
  }, [showCreateForm]);
  const queryClient = useQueryClient();

  const { data: projectTags = [] } = useQuery({
    queryKey: ["tags", projectId],
    queryFn: ({ signal }) => apiFetch<Tag[]>(`/api/tags?projectId=${projectId}`, { signal }),
  });

  const createTagMutation = useMutation({
    mutationFn: async (data: { name: string; color: string }) => {
      return apiFetch<Tag>("/api/tags", {
        method: "POST",
        body: JSON.stringify({ ...data, projectId }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tags", projectId] });
      setNewTagName("");
      setNewTagColor(PRESET_COLORS[0]);
      setShowCreateForm(false);
      toast.success("Тег создан");
    },
    onError: (error: Error) => {
      toast.error("Не удалось создать тег", {
        description: error?.message || "Попробуйте еще раз",
      });
    },
  });

  const updateTaskTagsMutation = useMutation({
    mutationFn: async ({ taskId, tagIds }: { taskId: string; projectId: string; tagIds: string[] }) => {
      return apiFetch(`/api/tasks/${taskId}/tags`, {
        method: "PUT",
        body: JSON.stringify({ tagIds }),
      });
    },
    onSuccess: (_data, { taskId, projectId }) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
      queryClient.invalidateQueries({ queryKey: ["activities", taskId] });
    },
    onError: (error) => {
      toast.error("Не удалось обновить теги задачи", {
        description: error?.message || "Попробуйте еще раз",
      });
    },
  });

  const selectedTagIds = selectedTags.map((t) => t.tag.id);

  const toggleTag = (tag: Tag) => {
    const isSelected = selectedTagIds.includes(tag.id);
    let newTags;

    if (isSelected) {
      // Remove tag
      newTags = selectedTags.filter((t) => t.tag.id !== tag.id);
    } else {
      // Add tag
      newTags = [...selectedTags, { tag }];
    }

    // Update local state immediately (optimistic update)
    if (onTagsChange) {
      onTagsChange(newTags);
    }

    // Sync with server
    const newTagIds = newTags.map((t) => t.tag.id);
    updateTaskTagsMutation.mutate({ taskId, projectId, tagIds: newTagIds });
  };

  const handleCreateTag = () => {
    if (!newTagName.trim()) {
      return;
    }
    createTagMutation.mutate({ name: newTagName.trim(), color: newTagColor });
  };

  return (
    <Popover open={open} onOpenChange={next=>{setOpen(next);if(!next)setSearch("");}}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="min-w-0 max-w-full gap-2">
          <TagIcon className="h-4 w-4" />
          <span>Теги</span>
          {selectedTags.length > 0 && (
            <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs">
              {selectedTags.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-1rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-0" align="start">
        {!showCreateForm ? (
          <Command>
            <CommandInput className="min-w-0" aria-label="Поиск тегов" placeholder="Поиск тегов..." value={search} onValueChange={setSearch} />
            <CommandList>
              <CommandEmpty>
                <div className="py-6 text-center text-sm">
                  <p className="text-muted-foreground">Теги не найдены</p>
                  <Button
                    ref={createButtonRef}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-2 min-h-11"
                    onClick={() => {
                      setShowCreateForm(true);
                    }}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Создать тег
                  </Button>
                </div>
              </CommandEmpty>
              <CommandGroup>
                {projectTags.map((tag) => (
                  <CommandItem
                    key={tag.id}
                    value={tag.id}
                    keywords={[tag.name]}
                    onSelect={() => toggleTag(tag)}
                    className="min-h-11 min-w-0"
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4 shrink-0",
                        selectedTagIds.includes(tag.id) ? "opacity-100" : "opacity-0"
                      )}
                    />
                    {search ? <span className="min-w-0 rounded bg-muted px-2 py-0.5 text-xs [overflow-wrap:anywhere]" style={{borderLeft:`3px solid ${tag.color}`}}><SearchHighlight text={tag.name} query={search}/></span> : <TagBadge tag={tag} className="min-w-0 max-w-full [&>span]:min-w-0 [&>span]:[overflow-wrap:anywhere]" />}
                  </CommandItem>
                ))}
              </CommandGroup>
              {projectTags.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup>
                    <button
                      ref={createButtonRef}
                      type="button"
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setShowCreateForm(true);
                      }}
                      className="relative flex min-h-11 w-full select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring cursor-pointer"
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Создать новый тег
                    </button>
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        ) : (
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-sm">Создать тег</h4>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11 shrink-0"
                aria-label="Вернуться к тегам"
                onClick={() => setShowCreateForm(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-3">
              <div>
                <label htmlFor={tagNameId} className="text-sm font-medium mb-1.5 block">Название</label>
                <Input
                  id={tagNameId}
                  ref={tagNameInputRef}
                  placeholder="Название тега"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleCreateTag();
                    }
                  }}
                />
              </div>

              <div>
                <label className="text-sm font-medium mb-1.5 block">Цвет</label>
                <div role="group" aria-label="Цвет тега" className="grid grid-cols-[repeat(auto-fit,minmax(2.75rem,1fr))] gap-2">
                  {PRESET_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={cn(
                        "h-11 w-11 rounded-md border-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                        newTagColor === color
                          ? "border-foreground scale-110"
                          : "border-transparent hover:scale-105"
                      )}
                      style={{ backgroundColor: color }}
                      aria-label={`Цвет ${color}`}
                      aria-pressed={newTagColor === color}
                      onClick={() => setNewTagColor(color)}
                    />
                  ))}
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={handleCreateTag}
                  disabled={!newTagName.trim() || createTagMutation.isPending}
                  className="flex-1"
                >
                  Создать
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setShowCreateForm(false)}
                >
                  Отмена
                </Button>
              </div>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
