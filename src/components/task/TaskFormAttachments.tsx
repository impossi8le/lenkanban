"use client";

import * as React from "react";
import { File as FileIcon, Image as ImageIcon, Loader2, Upload, X } from "lucide-react";
import { prepareImagesForUpload } from "@/lib/attachments/prepare-image";
import { apiFetch } from "@/lib/api";
import { getBrowserTelemetryClient } from "@/lib/telemetry/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Pending attachments for a task that does not exist yet.
 *
 * The same limits as `TaskAttachments` apply, and the same `/api/uploads/direct`
 * protocol is used once the task id is known. Nothing is uploaded before the
 * task is created: the server binds every object to an existing task.
 */
export const MAX_ATTACHMENT_FILES = 5;
export const MAX_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_BATCH_BYTES = 50 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const ALLOWED_TYPES_LABEL = "JPEG, PNG, WebP, PDF, DOCX, XLSX, PPTX";

export const ATTACHMENT_ACCEPT = [
  ...Object.keys(MIME_BY_EXTENSION).map((extension) => `.${extension}`),
  ...Object.values(MIME_BY_EXTENSION),
].join(",");

export type UploadedAttachment = {
  url: string;
  name: string;
  size: number;
  mime: string;
};

/** Client-side hint only; the server repeats every limit independently. */
export function validateAttachmentSelection(files: File[]): string | null {
  if (files.length > MAX_ATTACHMENT_FILES) {
    return `Можно загрузить не более ${MAX_ATTACHMENT_FILES} файлов за раз`;
  }
  if (files.some((file) => file.size < 1)) return "Пустой файл загрузить нельзя";
  if (files.some((file) => file.size > MAX_ATTACHMENT_FILE_BYTES)) return "Файл больше 25 МБ";
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BATCH_BYTES) {
    return "Суммарный размер файлов больше 50 МБ";
  }
  const unsupported = files.find((file) => {
    const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
    if (!Object.hasOwn(MIME_BY_EXTENSION, extension)) return true;
    // Some browsers leave `type` empty; the server still checks the signature.
    return Boolean(file.type) && file.type !== MIME_BY_EXTENSION[extension];
  });
  if (unsupported) {
    return `Недопустимый формат файла «${unsupported.name}». Разрешены: ${ALLOWED_TYPES_LABEL}`;
  }
  return null;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Uploads pending files through the existing direct-upload protocol. */
export async function uploadTaskAttachments(
  taskId: string,
  files: File[],
): Promise<UploadedAttachment[]> {
  const client = getBrowserTelemetryClient();
  const action = client?.beginAction("attachment.upload");
  const started = performance.now();
  let outcome: "success" | "failure" = "failure";
  try {
    const selectionError = validateAttachmentSelection(files);
    if (selectionError) throw new Error(selectionError);
    const normalized = files.map(file => file.type ? file : new File([file], file.name, {
      type: MIME_BY_EXTENSION[file.name.split(".").at(-1)?.toLowerCase() ?? ""], lastModified: file.lastModified,
    }));
    const prepared = await prepareImagesForUpload(normalized);
    const formData = new FormData();
    formData.append("taskId", taskId);
    for (const file of prepared) formData.append("files", file);
    const result = await apiFetch<{ uploaded: UploadedAttachment[]; count: number }>(
      "/api/uploads/direct",
      { method: "POST", body: formData },
    );
    if (!result || !Array.isArray(result.uploaded) || result.count !== files.length || result.uploaded.length !== files.length
      || result.uploaded.some(item => !item || typeof item.url !== "string" || !item.url || typeof item.name !== "string"
        || typeof item.mime !== "string" || !item.mime || typeof item.size !== "number" || !Number.isFinite(item.size) || item.size <= 0)) {
      throw new Error("UPLOAD_UNCONFIRMED");
    }
    if (result.uploaded.length > 0) outcome = "success";
    return result.uploaded;
  } finally {
    if (action) client?.finishAction(action, { outcome, durationMs: performance.now() - started });
  }
}

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return undefined;
}

export function isDefinitiveUploadRefusal(error: unknown): boolean {
  const status = statusOf(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

/**
 * Maps a sanitized server refusal to an actionable message. The task itself is
 * already created when this runs, so the text never claims the whole submission
 * failed.
 */
export function attachmentUploadErrorMessage(error: unknown, prefix: string): string {
  const status = statusOf(error);
  if (status === 503) {
    return `${prefix}: загрузка файлов сейчас недоступна на сервере. Проверьте вложения в сохранённой карточке перед повторной загрузкой.`;
  }
  if (status === 413) return `${prefix}: файлы превышают допустимый размер.`;
  if (status === 422) return `${prefix}: сервер отклонил формат или содержимое файла.`;
  if (status === 409) {
    const code = (error as { payload?: { error?: { code?: unknown } } }).payload?.error?.code;
    return code === "ATTACHMENT_QUOTA_EXCEEDED" ? `${prefix}: достигнут лимит вложений задачи.` : `${prefix}: сервер отклонил операцию. Обновите данные и повторите попытку.`;
  }
  return `${prefix}: не удалось загрузить файлы. Проверьте соединение и попробуйте ещё раз.`;
}

interface TaskFormAttachmentsProps {
  id: string;
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  busy?: boolean;
  status?: string | null;
  error?: string | null;
}

export function TaskFormAttachments({
  id,
  files,
  onChange,
  disabled = false,
  busy = false,
  status = null,
  error = null,
}: TaskFormAttachmentsProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [selectionError, setSelectionError] = React.useState<string | null>(null);
  const [isDragOver, setIsDragOver] = React.useState(false);
  const locked = disabled || busy;

  const addFiles = (incoming: File[]) => {
    if (locked || incoming.length === 0) return;
    const next = [...files, ...incoming];
    const message = validateAttachmentSelection(next);
    if (message) {
      setSelectionError(message);
      return;
    }
    setSelectionError(null);
    onChange(next);
  };

  const removeFile = (index: number) => {
    if (locked) return;
    setSelectionError(null);
    onChange(files.filter((_, position) => position !== index));
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (locked) return;
    setIsDragOver(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
    if (locked) return;
    addFiles(Array.from(event.dataTransfer.files));
  };

  const message = selectionError ?? error;

  return (
    <div className="min-w-0 space-y-3" aria-busy={busy || undefined}>
      <div
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        className={cn(
          "rounded-lg border-2 border-dashed p-4 text-center transition-colors",
          isDragOver
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25",
          locked && "opacity-70",
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex flex-col items-center gap-2">
          {busy ? (
            <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />
          ) : (
            <Upload className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          )}
          <p id={`${id}-label`} className="text-sm text-muted-foreground">
            Перетащите файлы сюда или выберите их на устройстве
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 min-w-11"
            disabled={locked}
            aria-describedby={`${id}-hint`}
            onClick={() => inputRef.current?.click()}
          >
            Выбрать файлы
          </Button>
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            До 25 МБ на файл · до 5 файлов · 50 МБ за раз. Фото, PDF, DOCX, XLSX, PPTX.
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          multiple
          accept={ATTACHMENT_ACCEPT}
          disabled={locked}
          aria-label="Файлы для вложения"
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            addFiles(selected);
            event.currentTarget.value = "";
          }}
        />
      </div>

      <p role="status" aria-live="polite" className="min-h-4 text-xs text-muted-foreground">
        {busy ? (status ?? "Загрузка вложений…") : (status ?? "")}
      </p>

      {message && (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      )}

      {files.length > 0 && (
        <ul className="space-y-2" aria-label="Выбранные файлы">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${file.size}-${index}`}
              className="flex min-w-0 items-center gap-2 rounded-md border bg-card p-2"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary">
                {file.type.startsWith("image/") ? (
                  <ImageIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <FileIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                )}
              </span>
              <span className="min-w-0 flex-1 text-xs [overflow-wrap:anywhere]">{file.name}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {formatAttachmentSize(file.size)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11 shrink-0"
                disabled={locked}
                aria-label={`Убрать файл: ${file.name}`}
                title="Убрать файл"
                onClick={() => removeFile(index)}
              >
                <X className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
