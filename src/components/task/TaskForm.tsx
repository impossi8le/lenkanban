"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createTaskSchema,
  type CreateTaskInput,
} from "@/lib/validators";
import {
  TaskFormAttachments,
  attachmentUploadErrorMessage,
  uploadTaskAttachments,
} from "./TaskFormAttachments";

interface TaskFormProps {
  projectId: string;
  defaultStatus?: string;
  /** Resolves with the created task so pending attachments can be bound to it. */
  onSubmit: (data: CreateTaskInput) => Promise<{ id?: string } | void>;
  onCancel?: () => void;
}

const applicantFieldsSchema = z.object({ title: createTaskSchema.shape.title, description: createTaskSchema.shape.description, projectId: createTaskSchema.shape.projectId });

export function TaskForm({ projectId, onSubmit, onCancel }: TaskFormProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [files, setFiles] = React.useState<File[]>([]);
  const [attachmentStatus, setAttachmentStatus] = React.useState<string | null>(null);
  const [attachmentError, setAttachmentError] = React.useState<string | null>(null);
  const [createdTaskId, setCreatedTaskId] = React.useState<string | null>(null);
  const [createdWithoutId, setCreatedWithoutId] = React.useState(false);
  const pendingRef = React.useRef(false);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<CreateTaskInput>({
    resolver: zodResolver(applicantFieldsSchema),
    defaultValues: {
      title: "",
      description: "",
      projectId,
    },
  });

  React.useEffect(() => {
    setValue("projectId", projectId);
  }, [projectId, setValue]);

  const uploadPendingAttachments = React.useCallback(
    async (taskId: string): Promise<boolean> => {
      if (files.length === 0) {
        setCreatedTaskId(null);
        return true;
      }
      setAttachmentError(null);
      setAttachmentStatus(`Загрузка ${files.length} файл(ов)…`);
      try {
        await uploadTaskAttachments(taskId, files);
        setFiles([]);
        setCreatedTaskId(null);
        setAttachmentStatus("Вложения прикреплены");
        return true;
      } catch (error) {
        setAttachmentStatus(null);
        setAttachmentError(
          attachmentUploadErrorMessage(error, "Задача создана, но вложения не прикрепились"),
        );
        setCreatedTaskId(taskId);
        return false;
      }
    },
    [files],
  );

  const handleFormSubmit = async (data: CreateTaskInput) => {
    if (pendingRef.current || createdWithoutId) return;
    pendingRef.current = true;
    setIsSubmitting(true);
    try {
      // A retry must not create a second task: only the failed upload repeats.
      if (createdTaskId) {
        await uploadPendingAttachments(createdTaskId);
        return;
      }

      const result = await onSubmit(applicantFieldsSchema.parse(data));
      const taskId =
        result && typeof result === "object" && typeof result.id === "string" ? result.id : null;

      if (files.length === 0) return;
      if (!taskId) {
        setCreatedWithoutId(true);
        setAttachmentError(
          "Задача создана, но её идентификатор не получен, поэтому вложения не прикреплены. Добавьте файлы в карточке задачи.",
        );
        return;
      }
      await uploadPendingAttachments(taskId);
    } finally {
      pendingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleFilesChange = (next: File[]) => {
    setFiles(next);
    setAttachmentError(null);
  };

  const lockedAfterCreation = createdTaskId !== null || createdWithoutId;

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-4" aria-busy={isSubmitting}>
      <div className="space-y-2">
        <Label htmlFor="title">Название</Label>
        <Input
          id="title"
          placeholder="Введите название задачи..."
          disabled={isSubmitting || lockedAfterCreation}
          {...register("title")}
          className={errors.title ? "border-destructive" : ""}
        />
        {errors.title && (
          <p className="text-xs text-destructive">{errors.title.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Описание</Label>
        <textarea
          id="description"
          placeholder="Опишите, что нужно сделать, и ожидаемый результат."
          aria-describedby="task-form-description-hint"
          disabled={isSubmitting || lockedAfterCreation}
          className={cn(
            "flex min-h-[80px] w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            errors.description && "border-destructive"
          )}
          {...register("description")}
        />
        <p id="task-form-description-hint" className="text-sm text-muted-foreground">
          В названии кратко укажите проблему. В описании — что произошло, ожидаемый результат и шаги повторения. При необходимости приложите снимок экрана или файл без паролей и токенов.
        </p>
        {errors.description && (
          <p className="text-xs text-destructive">{errors.description.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Вложения</p>
        <TaskFormAttachments
          id="task-form-attachments"
          files={files}
          onChange={handleFilesChange}
          disabled={isSubmitting || lockedAfterCreation}
          busy={isSubmitting && files.length > 0}
          status={attachmentStatus}
          error={attachmentError}
        />
        {createdTaskId && (
          <p className="text-xs text-muted-foreground">
            Задача уже создана. Повторная отправка только повторит загрузку вложений.
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-4">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Отмена
          </Button>
        )}
        <Button type="submit" disabled={isSubmitting || createdWithoutId}>
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {createdWithoutId ? "Задача создана" : createdTaskId ? "Повторить загрузку вложений" : "Создать задачу"}
        </Button>
      </div>
    </form>
  );
}
