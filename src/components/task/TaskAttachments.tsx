"use client";

import { useState, useCallback, useRef, useMemo, useEffect, useLayoutEffect } from "react";
import { X, Loader2, Image as ImageIcon, File, Download, Upload } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { attachmentPresentation, isAttachmentImage } from "@/lib/attachments/presentation";
import { uploadTaskAttachments } from "./TaskFormAttachments";

type Attachment = {
  url: string;
  name: string;
  size: number;
  mime: string;
  width?: number;
  height?: number;
};

type Props = {
  taskId: string;
  attachments: Attachment[];
  onUpdate: (attachments: Attachment[]) => void;
  version?: number;
  marked?: boolean;
  canRemove?: boolean;
  canUpload?: boolean;
  onCommitted?: () => void | Promise<void>;
};

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_BATCH_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 5;

function isImageMime(mime: string) {
  return isAttachmentImage(mime);
}

/** Client-side hint only; the server repeats every limit independently. */
function validateSelection(files: File[]): string | null {
  if (files.length > MAX_FILES) return `Можно загрузить не более ${MAX_FILES} файлов за раз`;
  if (files.some((file) => file.size < 1)) return "Пустой файл загрузить нельзя";
  if (files.some((file) => file.size > MAX_FILE_BYTES)) return "Файл больше 25 МБ";
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_BATCH_BYTES) {
    return "Суммарный размер файлов больше 50 МБ";
  }
  return null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TaskAttachments({ taskId, attachments: storedAttachments, onUpdate, version, marked = false, canRemove = false, canUpload = false, onCommitted }: Props) {
  const attachments = useMemo(() => attachmentPresentation(storedAttachments), [storedAttachments]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ url: string; name?: string } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scope = useRef({ taskId, epoch: 0, alive: true });
  const busy = useRef(false);
  const removal = useRef<{ operationId: string; expectedVersion: number; url: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [uncertainRemoval, setUncertainRemoval] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [versionFloor, setVersionFloor] = useState<number | null>(null);
  const latest = useRef({ attachments, onUpdate, onCommitted });
  latest.current = { attachments, onUpdate, onCommitted };
  if (scope.current.taskId !== taskId) {
    scope.current = { taskId, epoch: scope.current.epoch + 1, alive: true };
    busy.current = false; removal.current = null;
  }
  useEffect(() => { scope.current.alive = true; return () => { scope.current.alive = false; scope.current.epoch++; }; }, []);
  useLayoutEffect(() => { setIsUploading(false); setRemoving(false); setUncertainRemoval(false); setNeedsRefresh(false); setVersionFloor(null); setUploadError(null); setUploadProgress(null); setLightbox(null); }, [taskId]);
  const refresh = useCallback(async () => { try { await latest.current.onCommitted?.(); } catch { /* Refresh cannot undo a commit. */ } }, []);
  const validVersion = Number.isInteger(version) && version! >= 0 && version! < 2147483647;
  const removeAllowed = canRemove && validVersion;
  const awaitingVersion = versionFloor !== null && (!Number.isInteger(version) || version! < versionFloor);
  const operationBlocked = isUploading || removing || uncertainRemoval || needsRefresh || awaitingVersion;


  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!canUpload || awaitingVersion || files.length === 0 || busy.current || removal.current) return;
      const epoch = scope.current.epoch;
      const isCurrent = () => scope.current.alive && scope.current.taskId === taskId && scope.current.epoch === epoch;
      setUploadError(null);

      const selectionError = validateSelection(files);
      if (selectionError) {
        setUploadError(selectionError);
        return;
      }

      busy.current = true;
      setIsUploading(true);
      setUploadProgress(`Загрузка ${files.length} файл(ов)...`);

      try {
        const uploaded = await uploadTaskAttachments(taskId, files);

        if (!isCurrent()) return;
        if (uploaded.length > 0) {
          // Upload API auto-saves attachments to the task in DB,
          // so we just update local state
          const byUrl = new Map(latest.current.attachments.map(file => [file.url, file]));
          for (const file of attachmentPresentation(uploaded)) byUrl.set(file.url, file);
          latest.current.onUpdate([...byUrl.values()]);
          window.dispatchEvent(new CustomEvent('beznal:attachment-committed', { detail: { taskId, attachmentUrls: uploaded.map(file => file.url) } }));
          if (marked && Number.isInteger(version) && version! >= 0) setVersionFloor(version! + 1);
          await refresh();
          setUploadProgress(`Загружено ${uploaded.length} файл(ов)`);
        } else {
          setUploadProgress(null);
          setUploadError("Не удалось загрузить файлы");
        }
      } catch (error) {
        if (!isCurrent()) return;
        // Server responses are already sanitized; do not log the error object.
        setUploadProgress(null);
        setUploadError(
          error instanceof Error && error.message ? error.message : "Ошибка загрузки",
        );
      } finally {
        if (isCurrent()) { busy.current = false; setIsUploading(false);
          setTimeout(() => { if (isCurrent()) setUploadProgress(null); }, 3000);
        }
      }
    },
    [taskId, canUpload, marked, version, awaitingVersion, refresh]
  );

  const removeAttachment = useCallback(async (url?: string) => {
    if (busy.current || awaitingVersion) return;
    if (!removal.current) {
      if (!canRemove || !Number.isInteger(version) || version! < 0 || version! >= 2147483647 || !url) return;
      removal.current = { operationId: crypto.randomUUID(), expectedVersion: version!, url };
    }
    const intent = removal.current, epoch = scope.current.epoch;
    const isCurrent = () => scope.current.alive && scope.current.taskId === taskId && scope.current.epoch === epoch;
    busy.current = true; setRemoving(true); setUploadError(null); setNeedsRefresh(false);
    try {
      const ack = await apiFetch<{ taskId: string; version: number }>(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(intent),
      });
      if (!isCurrent()) return;
      if (ack.taskId !== taskId || ack.version !== intent.expectedVersion + 1) throw new Error("UNCONFIRMED_DETACH");
      latest.current.onUpdate(latest.current.attachments.filter(file => file.url !== intent.url));
      setLightbox(current => current?.url === intent.url ? null : current);
      removal.current = null; setUncertainRemoval(false); setVersionFloor(ack.version); await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
      const payload = error && typeof error === "object" && "payload" in error ? error.payload as { error?: { code?: string } } : undefined;
      if (typeof status === "number" && status >= 400 && status < 500) {
        removal.current = null; setUncertainRemoval(false); setNeedsRefresh(status !== 422);
        setUploadError(payload?.error?.code === "ATTACHMENT_IN_MESSAGE"
          ? "Этот файл опубликован в сообщении и остаётся частью переписки. Убрать его из карточки этим действием нельзя."
          : "Не удалось убрать вложение. Обновите карточку и повторите действие.");
      } else {
        setUncertainRemoval(true); setUploadError("Сервер не подтвердил удаление ссылки. Повторите удаление, чтобы проверить результат.");
      }
    } finally { if (isCurrent()) { busy.current = false; setRemoving(false); } }
  }, [taskId, version, canRemove, awaitingVersion, refresh]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        void uploadFiles(files);
      }
    },
    [uploadFiles]
  );

  return (
    <>
      <Dialog open={!!lightbox} onOpenChange={(open) => setLightbox(open ? lightbox : null)}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[900px] sm:max-w-[900px] min-w-0 border-0 bg-transparent p-0 shadow-none overflow-hidden">
          <DialogTitle className="sr-only">
            {lightbox?.name ? `Изображение: ${lightbox.name}` : "Изображение"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Просмотр изображения. Нажмите Esc или кликните вне окна, чтобы закрыть.
          </DialogDescription>

          <div className="relative flex min-w-0 w-full justify-center">
            <img
              src={lightbox?.url ?? ""}
              alt={lightbox?.name ?? ""}
              className="max-h-[85dvh] h-auto w-auto min-w-0 max-w-full rounded-md object-contain"
            />
          </div>
        </DialogContent>
      </Dialog>

      <div className="min-w-0 space-y-3">
        {/* Upload area */}
        {canUpload && <div
          className={cn(
            "relative rounded-lg border-2 border-dashed p-4 text-center transition-all",
            isDragOver
              ? "border-primary bg-primary/5 scale-[1.02]"
              : "border-muted-foreground/25 hover:border-muted-foreground/40",
            operationBlocked && "opacity-70 pointer-events-none"
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="flex flex-col items-center gap-2">
            {isUploading ? (
              <>
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">{uploadProgress}</p>
              </>
            ) : (
              <>
                <Upload className="h-6 w-6 text-muted-foreground" />
                <div>
                  <p className="text-sm text-muted-foreground">
                    Перетащите файлы сюда или{" "}
                    <button
                      type="button"
                      className="text-primary hover:underline cursor-pointer font-medium"
                      disabled={operationBlocked}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      выберите
                    </button>
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    До 25 МБ на файл · до 5 файлов · 50 МБ за раз
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Фото, PDF, DOCX, XLSX, PPTX
                  </p>
                </div>
              </>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            disabled={operationBlocked}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              void uploadFiles(files);
              e.currentTarget.value = "";
            }}
          />
        </div>}

        {/* Status message */}
        {uploadError && (
          <p role="alert" className="text-sm text-center text-destructive">
            {uploadError}
          </p>
        )}
        {awaitingVersion && <p role="status" className="text-sm text-muted-foreground">Файлы сохранены. Обновляем данные карточки… <button type="button" className="underline" onClick={() => void refresh()}>Обновить вложения</button></p>}
        {uncertainRemoval && <button type="button" className="text-sm underline" disabled={removing} onClick={() => void removeAttachment()}>Повторить удаление</button>}
        {needsRefresh && <button type="button" className="text-sm underline" onClick={() => { setNeedsRefresh(false); refresh(); }}>Обновить карточку</button>}
        {uploadProgress && !isUploading && (
          <p className="text-xs text-center text-muted-foreground animate-in fade-in">
            {uploadProgress}
          </p>
        )}

        {/* Attachments grid */}
        {attachments.length > 0 && (
          <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-2">
            {attachments.map((attachment) =>
              isImageMime(attachment.mime) ? (
                <div
                  key={attachment.url}
                  className="relative min-w-0 group rounded-lg overflow-hidden border bg-card shadow-sm hover:shadow-md transition-shadow"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setLightbox({ url: attachment.url, name: attachment.name })
                    }
                    className="block w-full"
                    aria-label={`Открыть изображение: ${attachment.name}`}
                  >
                    <img
                      src={attachment.url}
                      alt={attachment.name}
                      className="h-32 w-full object-cover hover:opacity-90 transition-opacity"
                      loading="lazy"
                    />
                  </button>
                  {removeAllowed && <button
                    type="button"
                    disabled={operationBlocked}
                    onClick={() => void removeAttachment(attachment.url)}
                    className="absolute right-1.5 top-1.5 h-9 w-9 rounded-full bg-background/90 backdrop-blur-sm flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-destructive hover:text-destructive-foreground"
                    aria-label={`Удалить вложение: ${attachment.name}`}
                    title="Удалить"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>}
                  <div className="min-w-0 px-2 py-1.5 text-xs text-muted-foreground flex flex-wrap items-center gap-1.5">
                    <ImageIcon className="h-3 w-3 flex-shrink-0" />
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{attachment.name}</span>
                    <span className="ml-auto flex-shrink-0 text-muted-foreground">
                      {formatFileSize(attachment.size)}
                    </span>
                  </div>
                </div>
              ) : (
                <div
                  key={attachment.url}
                  className="flex min-w-0 flex-wrap items-center gap-2.5 p-3 rounded-lg border bg-card shadow-sm group relative hover:shadow-md transition-shadow"
                >
                  <div className="h-9 w-9 rounded-md bg-secondary flex items-center justify-center flex-shrink-0">
                    <File className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0 basis-24">
                    <a
                      href={attachment.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-medium hover:underline [overflow-wrap:anywhere] block"
                      title={attachment.name}
                    >
                      {attachment.name}
                    </a>
                    <div className="text-[10px] text-muted-foreground">
                      {formatFileSize(attachment.size)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <a
                      href={attachment.url}
                      target="_blank"
                      rel="noreferrer"
                      download={attachment.name}
                      className="h-9 w-9 rounded flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-accent"
                      aria-label={`Скачать вложение: ${attachment.name}`}
                      title="Скачать"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                    {removeAllowed && <button
                      type="button"
                      disabled={operationBlocked}
                      onClick={() => void removeAttachment(attachment.url)}
                      className="h-9 w-9 rounded flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Удалить вложение: ${attachment.name}`}
                      title="Удалить"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>}
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </div>
    </>
  );
}
