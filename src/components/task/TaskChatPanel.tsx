"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { Loader2, Send, Paperclip, Trash2, Pencil, X, Smile } from "lucide-react";

import { prepareImagesForUpload } from "@/lib/attachments/prepare-image";
import { attachmentPresentation, isAttachmentImage } from "@/lib/attachments/presentation";
import { MAX_ATTACHMENT_FILES, MAX_ATTACHMENT_BATCH_BYTES, validateAttachmentSelection } from "./TaskFormAttachments";
import { apiFetch, apiPost } from "@/lib/api";
import { getBrowserTelemetryClient } from "@/lib/telemetry/client";
import type { ChatAttachment, ChatMessageDTO, ChatTypingDTO } from "@/lib/chat-types";
import { useTaskChat } from "@/hooks/useTaskChat";
import { useChatDraft } from "@/hooks/useChatDraft";
import { mentionSendErrorCopy, useComposerMentions } from "./useComposerMentions";
import { useSession } from "next-auth/react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Props = {
  taskId: string;
  mode?: "compact" | "thread";
  onReadinessChange?: (ready: boolean) => void;
};

type PendingAttachment = ChatAttachment & {
  localUrl?: string; // objectURL for preview while uploading
  state: "uploading" | "ready" | "error";
};

function isImageMime(mime: string) {
  return isAttachmentImage(mime);
}

type CommentVisibility = "PUBLIC" | "INTERNAL";

type ChatMessageView = ChatMessageDTO & {
  __delivery?: "pending" | "failed";
  isInternal?: boolean;
  version?: number;
  editedAt?: string | null;
  deletedAt?: string | null;
  canEdit?: boolean;
  canDelete?: boolean;
};

function validMessageVersion(version: unknown): version is number { return typeof version === "number" && Number.isInteger(version) && version >= 0 && version <= 2147483647; }
function messageCommandError(error: unknown, action: string): string {
  const code = (error as { payload?: { error?: { code?: unknown } } } | null)?.payload?.error?.code;
  return code === "STALE_MESSAGE_VERSION" || code === "STALE_TASK_VERSION"
    ? "Сообщение уже изменилось. Текущий текст сохранён в редакторе. Проверьте свежие данные перед повторным сохранением."
    : `Не удалось ${action} сообщение. Проверьте соединение и доступ. Введённый текст сохранён.`;
}

type MessagesPage = {
  items: ChatMessageView[];
  nextCursor: string | null;
  // Server decision. The toggle is only a convenience; POST/socket re-check it.
  canReadInternal?: boolean;
};

type MessageCacheUpdate = (page: MessagesPage | undefined) => MessagesPage | undefined;

function makeClientId() {
  return `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

type PresignResult = {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  token: string;
  expiresAt: string;
};

async function presignUpload(taskId: string, file: File): Promise<PresignResult> {
  // The server chooses the storage key and returns a one-object capability.
  // No client key, bucket or public URL is accepted.
  return apiPost<PresignResult>("/api/uploads/presign", {
    taskId,
    filename: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
  });
}

async function putUploadedBytes(presigned: PresignResult, file: Blob) {
  await apiFetch<{ uploaded: true }>(presigned.uploadUrl, {
    method: "PUT",
    headers: presigned.headers,
    body: file,
  });
}

async function finalizeUpload(taskId: string, token: string) {
  // Binds the staged object to the task and returns the canonical server URL.
  const result = await apiPost<{
    attachment: { url: string; name: string; size: number; mime: string };
    created: boolean;
  }>("/api/uploads/finalize", { taskId, token });
  return result.attachment;
}

/** A lost ACK must not leave a chat action pending indefinitely. */
function awaitChatMutation(send: (ack: (result: unknown) => void) => void, failure: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Сервер не подтвердил действие. Обновите обсуждение перед повтором."));
    }, 10_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    try {
      send(result => {
        const ack = result as { ok?: unknown } | null | undefined;
        finish(ack?.ok === true ? undefined : new Error(failure));
      });
    } catch { finish(new Error(failure)); }
  });
}

export function TaskChatPanel({ taskId, mode = "compact", onReadinessChange }: Props) {
  const thread = mode === "thread";
  const MessageViewport = thread ? "div" : ScrollArea;
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const { socket, isConnected, isJoined, lastError } = useTaskChat({ taskId });

  const { draft, setDraft, ready: draftReady, error: draftError } = useChatDraft(session?.user?.id, taskId);
  const draftRef = useRef(draft); draftRef.current = draft;
  const [typingUsers, setTypingUsers] = useState<Record<string, ChatTypingDTO>>({});
  const [isUploading, setIsUploading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const pendingAttachmentsRef = useRef(pendingAttachments); pendingAttachmentsRef.current = pendingAttachments;
  const uploadBusyRef = useRef(false);
  const internalComment = false;
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerMentions = useComposerMentions(session?.user?.id, taskId, draft, setDraft, !internalComment, () => composerRef.current?.focus());

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [mutationError, setMutationError] = useState<string | null>(null);

  const [lightbox, setLightbox] = useState<{ url: string; name?: string } | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState<string | null>(null);

  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [threadNewCount, setThreadNewCount] = useState(0);
  const lastMessageRef = useRef<HTMLDivElement>(null);

  const queryKey = useMemo(() => ["task-messages", taskId] as const, [taskId]);
  const snapshotEventsRef = useRef<{ taskId: string; updates: MessageCacheUpdate[] } | null>(null);
  const sendAttemptsRef = useRef(new Map<string, { taskId: string; cancel: () => void }>());
  const sendGenerationRef = useRef(0);
  const messageIntentsRef = useRef(new Map<string, { operationId: string; expectedVersion: number; contentText?: string }>());
  const olderRequestsRef = useRef(new Set<AbortController>());

  useEffect(() => {
    setOlderError(null); setThreadNewCount(0); setEditingId(null); setEditingText("");
    const attempts = sendAttemptsRef.current;
    const intents = messageIntentsRef.current;
    const pageRequests = olderRequestsRef.current;
    return () => {
      sendGenerationRef.current += 1;
      intents.clear();
      for (const request of pageRequests) request.abort();
      pageRequests.clear();
      for (const attempt of attempts.values()) {
        if (attempt.taskId === taskId) attempt.cancel();
      }
    };
  }, [taskId, session?.user?.id]);

  const { data, isLoading, isError, isFetching, isFetchedAfterMount, refetch } = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const pending = { taskId, updates: [] as MessageCacheUpdate[] };
      snapshotEventsRef.current = pending;
      try {
        const previous = queryClient.getQueryData<MessagesPage>(queryKey);
        const confirmedTimes = previous?.items.filter(message => !message.__delivery)
          .map(message => new Date(message.createdAt).getTime()).filter(Number.isFinite) ?? [];
        const oldestVisible = confirmedTimes.length ? Math.min(...confirmedTimes) : undefined;
        let fresh = await apiFetch<MessagesPage>(`/api/tasks/${taskId}/messages?limit=50`, { signal });
        const latestIds = new Set(fresh.items.map(message => message.id));
        const cursors = new Set<string>();
        // A live chat can grow beyond one page. Re-read its existing temporal
        // window, including missed arrivals, instead of retaining stale rows.
        while (oldestVisible !== undefined && fresh.nextCursor
          && !fresh.items.some(message => new Date(message.createdAt).getTime() < oldestVisible)) {
          const cursor = fresh.nextCursor;
          if (cursors.has(cursor)) throw new Error("Repeated message cursor");
          cursors.add(cursor);
          const older = await apiFetch<MessagesPage>(
            `/api/tasks/${taskId}/messages?limit=100&cursor=${encodeURIComponent(cursor)}`, { signal },
          );
          fresh = {
            items: [...older.items, ...fresh.items],
            nextCursor: older.nextCursor,
            canReadInternal: fresh.canReadInternal,
          };
        }
        if (oldestVisible !== undefined) {
          const items = fresh.items.filter(message => latestIds.has(message.id)
            || new Date(message.createdAt).getTime() >= oldestVisible);
          // Do not move the visible horizon backwards on every reaction.
          fresh = {
            items,
            nextCursor: items.length < fresh.items.length ? items[0]?.id ?? null : fresh.nextCursor,
            canReadInternal: fresh.canReadInternal,
          };
        }
        // A reconnect snapshot confirms server messages, but must not erase local
        // sends still awaiting delivery or retained for retry after a failure.
        const current = queryClient.getQueryData<MessagesPage>(queryKey);
        const serverIds = new Set(fresh.items.map(message => message.id));
        const serverClientIds = new Set(fresh.items.flatMap(message => message.clientId ? [message.clientId] : []));
        const unresolved = current?.items.filter(message =>
          message.__delivery && !serverIds.has(message.id)
          && !(message.clientId && serverClientIds.has(message.clientId)),
        ) ?? [];
        const snapshot = { ...fresh, items: [...fresh.items, ...unresolved] };
        // Apply only events received during this request, so a late HTTP
        // snapshot cannot undo live creates/deletes from the joined room.
        return pending.updates.reduce<MessagesPage | undefined>((page, update) => update(page), snapshot) ?? snapshot;
      } finally {
        if (snapshotEventsRef.current === pending) snapshotEventsRef.current = null;
      }
    },
  });

  useEffect(() => {
    onReadinessChange?.(isFetchedAfterMount && !isFetching && !isError && Boolean(data));
    return () => onReadinessChange?.(false);
  }, [onReadinessChange, isFetchedAfterMount, isFetching, isError, data]);

  // Room joins do not replay missed messages. Read only a successfully fetched
  // snapshot, and keep message changes out of the effect dependencies.
  useEffect(() => {
    if (!isJoined || !socket) return;
    let cancelled = false;
    const catchUp = async () => {
      try {
        const refreshed = await refetch({ throwOnError: true });
        if (cancelled || !socket.connected || !refreshed.isSuccess) return;
        const messageIds = refreshed.data.items
          .filter(message => !message.__delivery && !message.id.startsWith("optimistic_"))
          .map(message => message.id);
        for (let offset = 0; offset < Math.max(messageIds.length, 1); offset += 1000) {
          if (cancelled || !socket.connected) return;
          await apiPost(`/api/tasks/${taskId}/messages/read`, {
            messageIds: messageIds.slice(offset, offset + 1000),
          });
        }
        void queryClient.invalidateQueries({ queryKey: ["unread-counts"] });
      } catch {
        // Failed/cancelled catch-up must not mark unseen messages as read.
        // The existing cache remains visible; the next join can retry.
      }
    };
    void catchUp();
    return () => { cancelled = true; };
  }, [taskId, isJoined, socket, queryClient, refetch]);

  const messages: ChatMessageView[] = useMemo(() => {
    const items = Array.isArray(data?.items) ? data.items : [];
    // Deduplicate by ID to prevent React key warnings
    const seen = new Set<string>();
    return items.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    }).map(message => ({ ...message, attachments: attachmentPresentation(message.attachments) }));
  }, [data?.items]);

  // Server-owned decision from the last snapshot. It only decides whether the
  // internal switch is offered; POST/socket re-check access on the server.
  const canReadInternal = data?.canReadInternal === true;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    if (!scrollAreaRef.current) return;

    // Find the Radix UI viewport element
    const viewport = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    if (!viewport) return;

    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }, []);

  // Attach scroll listener to Radix viewport
  useEffect(() => {
    if (!scrollAreaRef.current) return;

    const viewport = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    if (!viewport) return;

    const handleScroll = () => {
      if (viewport.clientHeight === 0) return;
      const threshold = 80;
      const nearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < threshold;
      setIsNearBottom(nearBottom);
      if (nearBottom) setUnseenCount(0);
    };

    viewport.addEventListener('scroll', handleScroll);
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-scroll to bottom on initial load and when new messages arrive
  const prevMessagesLength = useRef(0);
  const hasScrolledInitially = useRef(false);

  useEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]');
    if (!viewport) return;
    let disposed = false;
    let firstFrame: number | undefined;
    let secondFrame: number | undefined;
    const scrollInitially = () => {
      if (disposed || !messages.length || hasScrolledInitially.current || viewport.clientHeight === 0) return;
      if (firstFrame !== undefined) cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
      // A force-mounted mobile pane can fetch messages before it is visible.
      // Complete initial scrolling only after the viewport has real dimensions.
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          if (disposed || viewport.clientHeight === 0) return;
          scrollToBottom("auto");
          hasScrolledInitially.current = true;
        });
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      if (disposed || viewport.clientHeight === 0) return;
      if (!hasScrolledInitially.current) scrollInitially();
      else if (isNearBottom) scrollToBottom("auto");
    });
    observer?.observe(viewport);

    if (!hasScrolledInitially.current) scrollInitially();
    else if (messages.length > prevMessagesLength.current && isNearBottom && viewport.clientHeight > 0) {
      scrollToBottom("smooth");
    }

    prevMessagesLength.current = messages.length;
    return () => {
      disposed = true;
      observer?.disconnect();
      if (firstFrame !== undefined) cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    };
  }, [messages.length, isNearBottom, scrollToBottom]);

  // Wire socket events into react-query cache
  useEffect(() => {
    if (!socket) return;
    const currentUserId = session?.user?.id;
    let disposed = false;
    let refreshing = false;
    let refreshRequested = false;

    // `isInternal` is part of the discussion DTO; older servers simply omit it.
    const onNew = (msg: ChatMessageDTO & { isInternal?: boolean }) => {
      if (msg.taskId !== taskId) return;
      // Defence in depth only. The socket layer owns room segregation and must
      // not emit internal rows to non-readers; here an unconfirmed reader never
      // renders one, while the author's own send still reconciles.
      if (msg.isInternal === true) {
        const page = queryClient.getQueryData<MessagesPage>(queryKey);
        if (page?.canReadInternal !== true && msg.authorId !== currentUserId) return;
      }
      if (thread && msg.authorId !== currentUserId && !queryClient.getQueryData<MessagesPage>(queryKey)?.items.some(message => message.id === msg.id)) setThreadNewCount(count => count + 1);
      const update: MessageCacheUpdate = (prev) => {
        if (!prev) return { items: [msg as ChatMessageView], nextCursor: null };

        // Another author's event cannot confirm a local optimistic send.
        if (msg.clientId && prev.items.some(message => message.__delivery
          && message.clientId === msg.clientId && message.authorId !== msg.authorId)) return prev;

        // A repeated creation event carries no version and may predate later
        // edits/reactions. Existing confirmed data always wins, including when
        // an unresolved sibling with the same clientId is still in the cache.
        const matches = (message: ChatMessageView) => message.id === msg.id
          || Boolean(msg.clientId && message.clientId === msg.clientId);
        if (prev.items.some(message => !message.__delivery && matches(message))) {
          const items = prev.items.filter(message => !(message.__delivery && matches(message)));
          return items.length === prev.items.length ? prev : { ...prev, items };
        }

        // Reconcile only unresolved optimistic delivery by clientId.
        const idx = msg.clientId
          ? prev.items.findIndex((m) => m.__delivery && m.clientId === msg.clientId)
          : -1;

        if (idx >= 0) {
          const next = [...prev.items];
          // Clear delivery marker on success
          next[idx] = { ...(msg as ChatMessageView), __delivery: undefined };
          return { ...prev, items: next };
        }

        // Append if not exists
        if (prev.items.some((m) => m.id === msg.id)) return prev;
        return { ...prev, items: [...prev.items, msg as ChatMessageView] };
      };
      if (snapshotEventsRef.current?.taskId === taskId) snapshotEventsRef.current.updates.push(update);
      queryClient.setQueryData<MessagesPage>(queryKey, update);
      if (validMessageVersion((msg as ChatMessageView).version)) void queryClient.invalidateQueries({ queryKey, exact: true });
    };

    const onUpdated = (msg: ChatMessageDTO) => {
      if (msg.taskId !== taskId) return;
      void queryClient.invalidateQueries({ queryKey: ["activities", taskId] });
      // Full update DTOs can arrive out of commit order. They are signals to
      // reload, never authoritative snapshots to apply or replay over a GET.
      refreshRequested = true;
      if (refreshing) return;
      refreshing = true;
      void (async () => {
        try {
          // Explicit cancellation also replaces an initial fetch with no cache.
          await queryClient.cancelQueries({ queryKey, exact: true });
          while (!disposed && refreshRequested) {
            refreshRequested = false;
            await queryClient.invalidateQueries(
              { queryKey, exact: true }, { cancelRefetch: false },
            );
            // Events during this GET request one trailing fetch instead of
            // repeatedly aborting requests and starving a busy chat of data.
          }
        } catch {
          // Preserve visible cache; the next update or room join can retry.
        } finally {
          refreshing = false;
        }
      })();
    };

    const onDeleted = (p: { taskId: string; messageId: string }) => {
      if (p.taskId !== taskId) return;
      const update: MessageCacheUpdate = (prev) => {
        if (!prev) return prev;
        return { ...prev, items: prev.items.filter((m) => m.id !== p.messageId) };
      };
      if (snapshotEventsRef.current?.taskId === taskId) snapshotEventsRef.current.updates.push(update);
      queryClient.setQueryData<MessagesPage>(queryKey, update);
    };

    const onTyping = (p: ChatTypingDTO) => {
      if (p.taskId !== taskId) return;
      setTypingUsers((prev) => {
        const next = { ...prev };
        if (!p.isTyping) {
          delete next[p.userId];
          return next;
        }
        next[p.userId] = p;
        return next;
      });
    };

    socket.on("message:new", onNew);
    socket.on("message:updated", onUpdated);
    socket.on("message:deleted", onDeleted);
    socket.on("typing", onTyping);

    return () => {
      disposed = true;
      socket.off("message:new", onNew);
      socket.off("message:updated", onUpdated);
      socket.off("message:deleted", onDeleted);
      socket.off("typing", onTyping);
    };
  }, [socket, queryClient, queryKey, taskId, session?.user?.id, thread]);

  const olderMutation = useMutation({
    mutationFn: async (payload: { cursor: string; taskId: string; generation: number }) => {
      const controller = new AbortController(); olderRequestsRef.current.add(controller);
      try {
        const older = await apiFetch<MessagesPage>(`/api/tasks/${payload.taskId}/messages?limit=50&cursor=${encodeURIComponent(payload.cursor)}`, { signal: controller.signal });
        if (!Array.isArray(older.items) || older.items.some(message => !message || typeof message.id !== "string" || message.taskId !== payload.taskId)
          || (older.nextCursor !== null && typeof older.nextCursor !== "string") || older.nextCursor === payload.cursor) throw new Error("Invalid message page");
        return older;
      } finally { olderRequestsRef.current.delete(controller); }
    },
    onMutate: () => setOlderError(null),
    onSuccess: (older, payload) => {
      if (payload.generation !== sendGenerationRef.current || payload.taskId !== taskId) return;
      const anchor = scrollAreaRef.current?.querySelector<HTMLElement>("[data-message-id]");
      const before = anchor?.getBoundingClientRect().top;
      const scroll = thread ? scrollAreaRef.current?.closest<HTMLElement>('[data-testid="task-detail-scroll"]')
        : scrollAreaRef.current?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
      const update: MessageCacheUpdate = previous => {
        if (!previous || previous.nextCursor !== payload.cursor) return previous;
        const seen = new Set(previous.items.map(message => message.id));
        return { ...previous, nextCursor: older.nextCursor, items: [...older.items.filter(message => { if (seen.has(message.id)) return false; seen.add(message.id); return true; }), ...previous.items] };
      };
      if (snapshotEventsRef.current?.taskId === taskId) snapshotEventsRef.current.updates.push(update);
      queryClient.setQueryData<MessagesPage>(queryKey, update);
      requestAnimationFrame(() => {
        if (payload.generation !== sendGenerationRef.current || !anchor?.isConnected || !scroll?.isConnected || before === undefined) return;
        scroll.scrollTop += anchor.getBoundingClientRect().top - before;
      });
    },
    onError: (_error, payload) => {
      if (payload.generation === sendGenerationRef.current) setOlderError("Не удалось загрузить предыдущие сообщения. Попробуйте ещё раз.");
    },
  });

  // Typing debounce
  const typingTimer = useRef<number | null>(null);
  const setTyping = useCallback(
    (isTyping: boolean) => {
      if (!socket) return;
      socket.emit("typing", { taskId, isTyping });
    },
    [socket, taskId]
  );

  const onDraftChange = (v: string) => {
    setDraft(v);
    setTyping(true);
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => setTyping(false), 900);
  };

  useEffect(() => {
    return () => {
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
    };
  }, []);

  const sendMutation = useMutation({
    mutationFn: async (payload: { taskId: string; generation: number; clientId: string; contentText: string; attachments: ChatAttachment[]; visibility: CommentVisibility; mentionUserIds: string[] }) => {
      const sendQueryKey = ["task-messages", payload.taskId] as const;
      const existing = queryClient.getQueryData<MessagesPage>(sendQueryKey)?.items;
      if (existing?.some(message => message.clientId === payload.clientId && !message.__delivery)) return true;
      sendAttemptsRef.current.get(payload.clientId)?.cancel();

      const client = getBrowserTelemetryClient();
      const action = client?.beginAction("comment.create");
      const started = performance.now();
      let outcome: "success" | "failure" = "failure";
      try {

        const sessionUser = session?.user as { id?: string; email?: string | null; name?: string | null; image?: string | null } | undefined;

        const optimistic: ChatMessageView = {
          id: `optimistic_${payload.clientId}`,
          clientId: payload.clientId,
          taskId: payload.taskId,
          authorId: sessionUser?.id ?? "unknown",
          author: {
            id: sessionUser?.id ?? "unknown",
            email: sessionUser?.email ?? "unknown",
            name: sessionUser?.name ?? null,
            avatarUrl: sessionUser?.image ?? null,
          },
          contentText: payload.contentText,
          attachments: payload.attachments,
          mentions: payload.mentionUserIds,
          reactions: {},
          createdAt: new Date().toISOString(),
          isInternal: payload.visibility === "INTERNAL",
          __delivery: "pending",
        };

        queryClient.setQueryData<MessagesPage>(sendQueryKey, (prev) => {
          const base = prev ?? { items: [], nextCursor: null };
          // If retrying, replace existing optimistic with same clientId
          const nextItems = base.items.map((m) =>
            m.__delivery && m.clientId === payload.clientId ? optimistic : m
          );
          const exists = nextItems.some((m) => m.clientId && m.clientId === payload.clientId);
          return { ...base, items: exists ? nextItems : [...base.items, optimistic] };
        });

        const markFailed = () => queryClient.setQueryData<MessagesPage>(sendQueryKey, previous => previous ? {
          ...previous, items: previous.items.map(message =>
            message.__delivery && message.id === optimistic.id && message.clientId === payload.clientId
              ? { ...message, __delivery: "failed" } : message),
        } : previous);

        // The socket path has no internal-only delivery channel, so an INTERNAL
        // comment goes through the guarded HTTP route that persists the marker and
        // re-authorizes the reader. Attachments are not supported there (#66).
        if (payload.visibility === "INTERNAL") {
          if (payload.attachments.length > 0) {
            markFailed();
            throw new Error("Вложения во внутреннем комментарии пока недоступны");
          }
          try {
            const created = await apiPost<ChatMessageView>(`/api/tasks/${payload.taskId}/messages`, {
              clientId: payload.clientId,
              contentText: payload.contentText,
              visibility: "INTERNAL",
              attachments: [],
              mentionUserIds: payload.mentionUserIds,
            });
            outcome = "success";
            queryClient.setQueryData<MessagesPage>(sendQueryKey, (previous) => {
              const confirmed: ChatMessageView = { ...created, isInternal: true, __delivery: undefined };
              const base = previous ?? { items: [], nextCursor: null };
              const index = base.items.findIndex(message =>
                message.__delivery && message.clientId === payload.clientId);
              if (index >= 0) {
                const items = [...base.items];
                items[index] = confirmed;
                return { ...base, items };
              }
              if (base.items.some(message => message.id === confirmed.id)) return base;
              return { ...base, items: [...base.items, confirmed] };
            });
            return true;
          } catch (error) {
            markFailed();
            throw error;
          }
        }

        // Submission may have been accepted just before a disconnect or task
        // switch. Retain its payload in the original task as a retryable failure.
        if (!socket?.connected || !isJoined || payload.generation !== sendGenerationRef.current || payload.taskId !== taskId) {
          markFailed();
          throw new Error(lastError ?? "Чат не подключен");
        }

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const attempt = { taskId: payload.taskId, cancel: () => finish(new Error("Send cancelled")) };
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.off("disconnect", onDisconnect);
            socket.off("message:new", onCanonical);
            if (sendAttemptsRef.current.get(payload.clientId) === attempt) {
              sendAttemptsRef.current.delete(payload.clientId);
              if (error) markFailed();
            }
            if (error) reject(error);
            else resolve();
          };
          const onDisconnect = () => finish(new Error("Send disconnected"));
          const onCanonical = (message: ChatMessageDTO) => {
            if (message.taskId === payload.taskId && message.clientId === payload.clientId
              && message.authorId === sessionUser?.id) finish();
          };
          sendAttemptsRef.current.set(payload.clientId, attempt);
          socket.on("disconnect", onDisconnect);
          socket.on("message:new", onCanonical);
          const timer = setTimeout(() => finish(new Error("Message confirmation timed out")), 10000);
          try {
            socket.emit(
              "message:send",
              {
                taskId: payload.taskId,
                clientId: payload.clientId,
                contentText: payload.contentText,
                attachments: payload.attachments,
                mentionUserIds: payload.mentionUserIds,
                // The server authorizes the internal type; this is a request, not a grant.
                visibility: payload.visibility,
              },
              (ack: unknown) => {
                const a = ack as { ok?: unknown; error?: unknown } | undefined;
                if (a?.ok !== true) finish(new Error(typeof a?.error === "string" ? a.error : "Send failed"));
                // ACK alone has no canonical DTO. Keep the bounded confirmation
                // timer until message:new; retry can request an idempotent replay.
              },
            );
          } catch (error) {
            finish(error instanceof Error ? error : new Error("Send failed"));
          }
        });

        // Server will emit message:new with same clientId which will reconcile.
        outcome = "success";
        return true;
      } finally {
        if (action) client?.finishAction(action, { outcome, durationMs: performance.now() - started });
      }
    },
    onSuccess: (_data, payload) => {
      if (payload.generation === sendGenerationRef.current && composerMentions.people.map(person => person.id).join() === payload.mentionUserIds.join()) composerMentions.clear();
    },
    onError: (error, payload) => {
      if (payload.generation !== sendGenerationRef.current || !payload.mentionUserIds.length) return;
      if (!draftRef.current) setDraft(payload.contentText);
      setMutationError(mentionSendErrorCopy(error));
    },
    onSettled: () => {
      // update task counts
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const mutationFailure = (error: Error) => {
    setMutationError(error.message);
    void queryClient.invalidateQueries({ queryKey });
  };
  const editMutation = useMutation({
    mutationFn: async (payload: { messageId: string; contentText: string; attachments: ChatAttachment[]; expectedVersion?: number; canonical?: boolean; targetTaskId: string; generation: number }) => {
      {
        if (!validMessageVersion(payload.expectedVersion)) throw new Error("Invalid version");
        const key = JSON.stringify([payload.targetTaskId, payload.messageId, payload.expectedVersion, "edit", payload.contentText]);
        let intent = messageIntentsRef.current.get(key);
        if (!intent) { intent = { operationId: crypto.randomUUID(), expectedVersion: payload.expectedVersion, contentText: payload.contentText }; messageIntentsRef.current.set(key, intent); }
        await apiFetch(`/api/tasks/${payload.targetTaskId}/messages/${encodeURIComponent(payload.messageId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(intent) });
        messageIntentsRef.current.delete(key); return;
      }
    },
    onMutate: () => setMutationError(null),
    onSuccess: (_data, payload) => { if (payload.generation !== sendGenerationRef.current) return; setEditingId(null); void queryClient.invalidateQueries({ queryKey }); void queryClient.invalidateQueries({ queryKey: ["activities", payload.targetTaskId] }); },
    onError: (error, payload) => { if (payload.generation !== sendGenerationRef.current) return; setMutationError(messageCommandError(error, "изменить")); void queryClient.invalidateQueries({ queryKey }); },
  });

  const deleteMutation = useMutation({
    mutationFn: async (payload: { messageId: string; expectedVersion?: number; canonical?: boolean; targetTaskId: string; generation: number }) => {
      {
        if (!validMessageVersion(payload.expectedVersion)) throw new Error("Invalid version");
        const key = JSON.stringify([payload.targetTaskId, payload.messageId, payload.expectedVersion, "delete"]);
        let intent = messageIntentsRef.current.get(key);
        if (!intent) { intent = { operationId: crypto.randomUUID(), expectedVersion: payload.expectedVersion }; messageIntentsRef.current.set(key, intent); }
        await apiFetch(`/api/tasks/${payload.targetTaskId}/messages/${encodeURIComponent(payload.messageId)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(intent) });
        messageIntentsRef.current.delete(key); return;
      }
    },
    onMutate: () => setMutationError(null),
    onSuccess: (_data, payload) => { if (payload.generation !== sendGenerationRef.current) return; void queryClient.invalidateQueries({ queryKey }); void queryClient.invalidateQueries({ queryKey: ["activities", payload.targetTaskId] }); },
    onError: (error, payload) => { if (payload.generation !== sendGenerationRef.current) return; setMutationError(messageCommandError(error, "удалить")); void queryClient.invalidateQueries({ queryKey }); },
  });

  const reactMutation = useMutation({
    mutationFn: async (payload: { messageId: string; emoji: string; action: 'add' | 'remove' }) => {
      if (!socket?.connected) throw new Error("Нет соединения с обсуждением. Дождитесь подключения.");
      await awaitChatMutation(ack => socket.emit("message:react", { taskId, ...payload }, ack),
        "Не удалось изменить реакцию. Обновите карточку и попробуйте снова.");
    },
    onMutate: () => setMutationError(null),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey }); },
    onError: mutationFailure,
  });

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    // Internal comments cannot carry attachments until they have their own
    // download authorization (#66); finalize would otherwise expose the file to
    // every task reader through Task.attachments.
    if (internalComment) return;

    if (uploadBusyRef.current) { setMutationError("Дождитесь завершения загрузки файлов."); return; }
    const existing = pendingAttachmentsRef.current;
    const selectionError = existing.length + files.length > MAX_ATTACHMENT_FILES
      ? `Можно добавить не более ${MAX_ATTACHMENT_FILES} файлов за раз`
      : existing.reduce((total, item) => total + item.size, 0) + files.reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BATCH_BYTES
        ? "Суммарный размер файлов больше 50 МБ" : validateAttachmentSelection(files);
    if (selectionError) { setMutationError(selectionError); return; }
    uploadBusyRef.current = true; setIsUploading(true); setMutationError(null);
    const generation = sendGenerationRef.current;
    const optimistic: PendingAttachment[] = [];
    try {
    const prepared = await prepareImagesForUpload(files);
    if (generation !== sendGenerationRef.current) return;
    for (const file of prepared) {
      const mime = file.type || "application/octet-stream";
      const localUrl = isImageMime(mime) ? URL.createObjectURL(file) : undefined;
      const pending: PendingAttachment = { url: `pending_${Date.now()}_${Math.random().toString(16).slice(2)}`, name: file.name, size: file.size, mime, localUrl, state: "uploading" };
      optimistic.push(pending);
    }

    setPendingAttachments((prev) => [...prev, ...optimistic]);
    setIsUploading(true);

      for (let i = 0; i < prepared.length; i++) {
        if (generation !== sendGenerationRef.current) break;
        const file = prepared[i];
        const pending = optimistic[i];
        if (!file || !pending) continue;

        const client = getBrowserTelemetryClient();
        const action = client?.beginAction("attachment.upload");
        const started = performance.now();
        let outcome: "success" | "failure" = "failure";
        try {
          const presigned = await presignUpload(taskId, file);
          await putUploadedBytes(presigned, file);
          const attachment = await finalizeUpload(taskId, presigned.token);
          outcome = "success";
          if (generation !== sendGenerationRef.current) break;

          setPendingAttachments((prev) => {
            // If user removed this attachment while it was uploading, ignore the result.
            if (!prev.some((a) => a.url === pending.url)) return prev;
            return prev.map((a) =>
              a.url === pending.url
                ? {
                    ...a,
                    url: attachment.url,
                    name: attachment.name,
                    size: attachment.size,
                    mime: attachment.mime,
                    state: "ready",
                  }
                : a
            );
          });
        } catch {
          setPendingAttachments((prev) => {
            if (!prev.some((a) => a.url === pending.url)) return prev;
            return prev.map((a) => (a.url === pending.url ? { ...a, state: "error" } : a));
          });
        } finally {
          if (action) client?.finishAction(action, { outcome, durationMs: performance.now() - started });
        }
      }
    } catch {
      for (const pending of optimistic) if (pending.localUrl) URL.revokeObjectURL(pending.localUrl);
      setPendingAttachments(previous => previous.filter(item => !optimistic.some(pending => pending.url === item.url)));
      setMutationError("Не удалось подготовить файлы. Попробуйте добавить их ещё раз.");
    } finally {
      uploadBusyRef.current = false; setIsUploading(false);
    }
  }, [taskId, internalComment]);

  const removePendingAttachment = useCallback((url: string) => {
    setPendingAttachments((prev) => {
      const target = prev.find((a) => a.url === url);
      if (target?.localUrl) URL.revokeObjectURL(target.localUrl);
      return prev.filter((a) => a.url !== url);
    });
  }, []);

  const onPaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it) continue;
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }

      if (files.length > 0) {
        e.preventDefault();
        if (!internalComment) await uploadFiles(files);
      }
    },
    [uploadFiles, internalComment]
  );

  // Cleanup object URLs
  useEffect(() => {
    return () => {
      for (const a of pendingAttachmentsRef.current) {
        if (a.localUrl) URL.revokeObjectURL(a.localUrl);
      }
    };
  }, []);

  const submit = async () => {
    if (!draftReady || isUploading || sendMutation.isPending) return;
    const content = draft.trim();
    const attachments = pendingAttachments
      .filter((a) => a.state === "ready")
      .map((a) => ({ url: a.url, name: a.name, size: a.size, mime: a.mime, width: a.width, height: a.height }));
    if (!content && attachments.length === 0) return;

    const clientId = makeClientId();

    // The client switch is only a request; the server re-checks internal access
    // and rejects it when the actor may not read the internal part. An internal
    // comment is sent over HTTP, so it does not require a live socket.
    const visibility: CommentVisibility = internalComment && canReadInternal ? "INTERNAL" : "PUBLIC";
    if (visibility === "PUBLIC" && (!socket?.connected || !isConnected || !isJoined)) return;
    // Defence in depth for an upload that finished while the switch was being
    // toggled: an internal comment is never sent with task-wide attachments.
    if (visibility === "INTERNAL" && attachments.length > 0) return;

    setDraft("");
    for (const attachment of pendingAttachmentsRef.current) if (attachment.localUrl) URL.revokeObjectURL(attachment.localUrl);
    setPendingAttachments([]);
    setTyping(false);

    sendMutation.mutate({ taskId, generation: sendGenerationRef.current, clientId, contentText: content, attachments, visibility, mentionUserIds: composerMentions.people.map(person => person.id) });
  };

  const typingLabel = Object.values(typingUsers)
    .filter((u) => u.isTyping)
    .map((u) => u.userName || "Someone")
    .slice(0, 2)
    .join(", ");

  const commonEmojis = ["👍", "❤️", "😊", "🎉", "🚀", "👀", "🔥", "✅"];

  const toggleReaction = (messageId: string, emoji: string) => {
    const message = messages.find((m) => m.id === messageId);
    if (!message) return;

    const currentUserId = session?.user?.id;
    if (!currentUserId) return;

    const hasReacted = message.reactions?.[emoji]?.includes(currentUserId);
    reactMutation.mutate({
      messageId,
      emoji,
      action: hasReacted ? 'remove' : 'add',
    });
  };

  const renderMessageText = (text: string, mentions: string[]) => {
    if (!mentions || mentions.length === 0) return text;

    // Replace @userId or @email with highlighted mentions
    const mentionRegex = /@(\w+)/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;

    while ((match = mentionRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index));
      }
      parts.push(
        <span key={match.index} className="bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1 rounded">
          {match[0]}
        </span>
      );
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return parts.length > 0 ? parts : text;
  };

  // Update unseen count when messages change
  // (scrolling is handled by the effect above)
  useEffect(() => {
    if (isNearBottom) {
      setUnseenCount(0);
    } else if (messages.length > prevMessagesLength.current) {
      setUnseenCount((c) => c + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, isNearBottom]);

  return (
    <>
      <Dialog open={!!lightbox} onOpenChange={(open) => setLightbox(open ? lightbox : null)}>
        <DialogContent className="w-auto max-w-[min(900px,95vw)] border-0 bg-transparent p-0 shadow-none">
          <DialogTitle className="sr-only">
            {lightbox?.name ? `Изображение: ${lightbox.name}` : "Изображение"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Просмотр изображения. Нажмите Escape или кликните по фону, чтобы закрыть.
          </DialogDescription>

          <div className="relative">
            <img
              src={lightbox?.url ?? ""}
              alt={lightbox?.name ?? ""}
              className="max-h-[85dvh] h-auto w-auto max-w-[min(900px,95vw)] rounded-md object-contain"
            />
          </div>
        </DialogContent>
      </Dialog>

      <div data-testid="task-conversation" data-mode={mode} className={thread ? "min-w-0 space-y-4 rounded-xl border bg-card p-3 sm:p-4" : "flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card"}>
      <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 p-2 [@media(max-height:420px)]:py-1">
          <div className={`${thread ? "text-base" : "text-xs"} min-w-0 text-muted-foreground [overflow-wrap:anywhere]`}>
            Сообщения по обращению
            {isConnected && isJoined ? "" : " · нет соединения"}
            {!isConnected || !isJoined ? (
              <span className="ml-2 text-sm">{lastError ? "Отправка временно недоступна. Проверьте подключение." : "Подключаемся…"}</span>
            ) : null}
          </div>
        <div className={`${thread ? "text-base" : "text-xs"} min-w-0 text-muted-foreground [overflow-wrap:anywhere]`}>
          {isUploading ? "Загрузка..." : typingLabel ? `${typingLabel} печатает...` : ""}
        </div>
      </div>
      <Separator />
      {mutationError && <p role="alert" className="shrink-0 p-2 text-sm text-destructive">{mutationError}</p>}

       <div ref={scrollAreaRef} className={thread ? "relative min-w-0" : "flex-1 min-h-0 min-w-0 relative flex flex-col"}>
        {thread && threadNewCount > 0 && <button type="button" className="mb-3 min-h-12 rounded-md border px-3 text-base" onClick={() => { lastMessageRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); setThreadNewCount(0); }}>Показать новые сообщения ({threadNewCount})</button>}
        {!isNearBottom && unseenCount > 0 ? (
          <button
            type="button"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 rounded-full border bg-background px-3 py-1 text-xs shadow hover:bg-accent"
            onClick={() => {
              scrollToBottom("smooth");
              setUnseenCount(0);
            }}
          >
            Новые сообщения ({unseenCount})
          </button>
        ) : null}

        <MessageViewport className={thread ? "min-w-0" : "flex-1 min-h-0"}>
          <div className={thread ? "space-y-4" : "p-2 space-y-2"}>
            {data?.nextCursor && <Button type="button" variant="outline" className="min-h-12 w-full whitespace-normal text-base" disabled={olderMutation.isPending} onClick={() => olderMutation.mutate({ cursor: data.nextCursor!, taskId, generation: sendGenerationRef.current })}>{olderMutation.isPending ? "Загружаем сообщения…" : "Показать предыдущие сообщения"}</Button>}
            {olderError && <p role="alert" className="text-base text-destructive">{olderError}</p>}
               {isError && (
            <div role="alert" className="space-y-2 p-2 text-sm text-destructive [overflow-wrap:anywhere]">
              <p>Не удалось загрузить сообщения.</p>
              {messages.length > 0 && <p>Отображаются ранее загруженные сообщения.</p>}
              <Button type="button" variant="outline" size="sm" className="min-h-11 max-w-full whitespace-normal" disabled={isFetching} onClick={() => void refetch()}>
                Повторить загрузку сообщений
              </Button>
            </div>
          )}
               {isLoading ? (
            <div className="text-xs text-muted-foreground p-2">Загрузка...</div>
          ) : messages.length === 0 ? (
            !isError && <div className="text-xs text-muted-foreground p-2">Пока нет сообщений</div>
          ) : (
            messages.map((m) => (
              <div key={m.id} data-message-id={m.id} className={thread ? "rounded-lg border bg-background p-4" : "rounded-md border bg-background p-2"}>
                <div className="flex items-start gap-2">
                  <Avatar className="h-7 w-7">
                    <AvatarFallback className="text-[10px]">
                      {(m.author.name?.[0] ?? m.author.email?.[0] ?? "?").toUpperCase()}
                    </AvatarFallback>
                  </Avatar>

                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                      <div className={thread ? "min-w-0 text-base font-semibold [overflow-wrap:anywhere]" : "min-w-0 text-xs font-medium [overflow-wrap:anywhere]"}>
                        {m.author.name ?? m.author.email}
                      </div>
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        {m.isInternal ? (
                          <span className="rounded border border-amber-500/60 bg-amber-500/10 px-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                            Внутреннее
                          </span>
                        ) : null}
                        <span className={thread ? "text-sm text-muted-foreground" : "text-[10px] text-muted-foreground"}>
                          {format(new Date(m.createdAt), "d MMM, HH:mm", { locale: ru })}
                        </span>
                      </div>
                    </div>

                    {editingId === m.id && !m.deletedAt ? (
                      <div className="space-y-2 mt-2">
                        <textarea
                          aria-label="Текст сообщения"
                          rows={3}
                          maxLength={20000}
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          className="min-h-28 w-full rounded-md border bg-background px-3 py-3 text-[18px] leading-relaxed outline-none"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            onClick={() => {
                              editMutation.mutate({ messageId: m.id, contentText: editingText.trim(), attachments: m.attachments, expectedVersion: m.version, canonical: m.canEdit === true, targetTaskId: taskId, generation: sendGenerationRef.current });
                            }}
                            className="min-h-12 text-base"
                            disabled={editMutation.isPending || m.canEdit !== true || !validMessageVersion(m.version) || !editingText.trim()}
                          >
                            Сохранить
                          </Button>
                          <Button size="sm" variant="outline" className="min-h-12 text-base" disabled={editMutation.isPending} onClick={() => setEditingId(null)}>
                            Отмена
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className={thread ? "mt-3 whitespace-pre-wrap text-[18px] leading-relaxed [overflow-wrap:anywhere]" : "text-sm whitespace-pre-wrap [overflow-wrap:anywhere] mt-1"}>
                        {m.deletedAt ? <span className="italic text-muted-foreground">Сообщение удалено</span> : renderMessageText(m.contentText, m.mentions || [])}
                      </div>
                    )}

                    {!m.deletedAt && m.editedAt && <p className="mt-2 text-sm text-muted-foreground">Изменено{Number.isFinite(Date.parse(m.editedAt)) ? ` ${format(new Date(m.editedAt), "d MMM, HH:mm", { locale: ru })}` : ""}</p>}

                    {!m.deletedAt && m.attachments?.length ? (
                      <div className="mt-2 space-y-2">
                        <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
                          {m.attachments?.map((a) =>
                            isImageMime(a.mime) ? (
                              <button
                                key={a.url}
                                type="button"
                                className="block min-w-0 text-left"
                                title={a.name}
                                onClick={() => setLightbox({ url: a.url, name: a.name })}
                              >
                                <img
                                  src={a.url}
                                  alt={a.name}
                                  className="h-28 w-full object-cover rounded border hover:opacity-90"
                                  loading="lazy"
                                />
                                {thread && <span className="mt-1 block text-sm [overflow-wrap:anywhere]">{a.name}</span>}
                              </button>
                            ) : (
                              <a
                                key={a.url}
                                href={a.url}
                                target="_blank"
                                rel="noreferrer"
                                className={`${thread ? "text-base" : "text-xs"} block min-w-0 underline text-muted-foreground hover:text-foreground [overflow-wrap:anywhere]`}
                                title={a.name}
                              >
                                {a.name} · {Math.round(a.size / 1024)} KB
                              </a>
                            )
               )}
             </div>
                      </div>
                    ) : null}

                    {!m.deletedAt && m.reactions && Object.keys(m.reactions).length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {Object.entries(m.reactions).map(([emoji, userIds]) => {
                          const currentUserId = session?.user?.id;
                          const hasReacted = currentUserId && userIds.includes(currentUserId);
                          return (
                            <button
                              key={emoji}
                              type="button"
                              onClick={() => toggleReaction(m.id, emoji)}
                              className={`inline-flex items-center gap-1 ${thread ? "min-h-12 px-3 text-base" : "px-2 py-0.5 text-xs"} rounded-full border ${
                                hasReacted
                                  ? "bg-blue-100 dark:bg-blue-900 border-blue-300 dark:border-blue-700"
                                  : "bg-background hover:bg-accent"
                              }`}
                            >
                              <span>{emoji}</span>
                              <span className={thread ? "text-sm" : "text-[10px]"}>{userIds.length}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {(m.__delivery === "pending" || m.__delivery === "failed") && (
                      <div className={`mt-2 ${thread ? "text-base" : "text-[10px]"} text-muted-foreground flex items-center gap-2`}>
                        {m.__delivery === "pending" ? (
                          <span>отправляется…</span>
                        ) : (
                          <>
                            <span className="text-red-500">ошибка отправки</span>
                            <button
                              type="button"
                              disabled={!isConnected || !isJoined || sendMutation.isPending}
                              className={`${thread ? "min-h-12 px-2" : ""} underline hover:text-foreground`}
                              onClick={() =>
                                sendMutation.mutate({
                                  taskId,
                                  generation: sendGenerationRef.current,
                                  clientId: m.clientId ?? makeClientId(),
                                  contentText: m.contentText,
                                  attachments: m.attachments ?? [],
                                  mentionUserIds: m.mentions ?? [],
                                  visibility: m.isInternal ? "INTERNAL" : "PUBLIC",
                                })
                              }
                            >
                              {thread ? "Повторить отправку" : "повторить"}
                            </button>
                          </>
                        )}
                      </div>
                    )}

                    {!m.deletedAt && <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Popover open={emojiPickerOpen === m.id} onOpenChange={(open) => setEmojiPickerOpen(open ? m.id : null)}>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            size={thread ? "sm" : "icon"}
                            variant="ghost"
                            className={thread ? "min-h-12 gap-2 px-3 text-base" : "h-7 w-7"}
                            aria-label="Добавить реакцию"
                          >
                            <Smile className="h-4 w-4" />
                            {thread && <span>Реакция</span>}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-2" align="start">
                          <div className="flex gap-1">
                            {commonEmojis.map((emoji) => (
                              <button
                                key={emoji}
                                type="button"
                                onClick={() => {
                                  toggleReaction(m.id, emoji);
                                  setEmojiPickerOpen(null);
                                }}
                                className={`${thread ? "min-h-12 min-w-12" : "p-1"} text-xl hover:bg-accent rounded`}
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                      {!m.__delivery && m.authorId === session?.user?.id && (
                        <>
                          {m.canEdit === true && validMessageVersion(m.version) && <Button
                            type="button"
                            size={thread ? "sm" : "icon"}
                            variant="ghost"
                            className={thread ? "min-h-12 gap-2 px-3 text-base" : "h-7 w-7"}
                            onClick={() => {
                              setEditingId(m.id);
                              setEditingText(m.contentText);
                            }}
                            aria-label={m.canEdit === true ? "Изменить сообщение" : "Редактировать"}
                          >
                            <Pencil className="h-4 w-4" />
                            {thread && <span>Изменить</span>}
                          </Button>}
                          {m.canDelete === true && validMessageVersion(m.version) && <Button
                            type="button"
                            size={thread ? "sm" : "icon"}
                            variant="ghost"
                            className={thread ? "min-h-12 gap-2 px-3 text-base" : "h-7 w-7"}
                            disabled={deleteMutation.isPending}
                            onClick={() => deleteMutation.mutate({ messageId: m.id, expectedVersion: m.version, canonical: m.canDelete === true, targetTaskId: taskId, generation: sendGenerationRef.current })}
                            aria-label={m.canDelete === true ? "Удалить сообщение" : "Удалить"}
                          >
                            <Trash2 className="h-4 w-4" />
                            {thread && <span>Удалить сообщение</span>}
                          </Button>}
                        </>
                      )}
                    </div>}
                  </div>
                </div>
              </div>
            ))
          )}
            <div ref={lastMessageRef} />
          </div>
        </MessageViewport>
      </div>

      <Separator />

      {pendingAttachments.length ? (
        <div className="min-h-0 min-w-0 shrink p-2 space-y-2 max-h-40 overflow-auto">
          <div className={`${thread ? "text-base" : "text-[10px]"} text-muted-foreground`}>Вложения к отправке:</div>
          <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
            {pendingAttachments.map((a) => (
              <div key={a.url} className="min-w-0 rounded-md border bg-background p-2 relative">
                <button
                  type="button"
                  onClick={() => removePendingAttachment(a.url)}
                  className={`absolute right-1 top-1 inline-flex ${thread ? "h-12 w-12" : "h-6 w-6"} items-center justify-center rounded bg-background/90 hover:bg-accent text-muted-foreground hover:text-foreground`}
                  aria-label="Удалить вложение"
                  title="Удалить"
                >
                  <X className="h-4 w-4" />
                </button>

                {isImageMime(a.mime) && a.localUrl ? (
                  <img
                    src={a.localUrl}
                    alt={a.name}
                    className="h-20 w-full object-cover rounded"
                  />
                ) : (
                  <div className={`${thread ? "text-base pr-12" : "text-xs pr-6"} truncate`}>{a.name}</div>
                )}

                <div className="mt-1 flex items-center justify-between gap-2">
                  <div className={`${thread ? "text-sm pr-12" : "text-[10px] pr-6"} text-muted-foreground truncate`}>
                    {a.name}
                  </div>
                  <div className={`${thread ? "text-sm" : "text-[10px]"} text-muted-foreground whitespace-nowrap`}>
                    {a.state === "uploading" ? "загрузка…" : a.state === "error" ? "ошибка" : "готово"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div
        className="min-w-0 shrink-0 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))]"
        data-testid="chat-composer"
      >
        <p className="mb-2 text-base font-medium">Написать сообщение</p>
        <div className={thread ? "flex min-w-0 flex-wrap gap-3" : "flex min-w-0 gap-2"}>
          <label
            className={`inline-flex ${thread ? "order-2 min-h-12 gap-2 px-3 text-base" : "h-11 w-11"} shrink-0 items-center justify-center rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ${
              internalComment ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-accent"
            }`}
            title={internalComment ? "Вложения во внутреннем комментарии пока недоступны" : undefined}
          >
            <Paperclip className="h-4 w-4 text-muted-foreground" />
            {thread && <span>Прикрепить файлы</span>}
            <input
              type="file"
              className="sr-only"
              aria-label="Прикрепить файлы к сообщению"
              multiple
              disabled={internalComment}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                void uploadFiles(files);
                e.currentTarget.value = "";
              }}
            />
          </label>

          <textarea
            ref={composerRef}
            value={draft}
            rows={thread ? 3 : 1}
            disabled={!draftReady}
            maxLength={20_000}
            onChange={(e) => { onDraftChange(e.target.value); composerMentions.change(e.target.value, e.target.selectionStart); }}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (composerMentions.onKeyDown(e)) return;
              if (e.key === "Enter" && !e.shiftKey && !e.altKey
                && !e.nativeEvent.isComposing && e.keyCode !== 229 && !e.repeat) {
                e.preventDefault();
                void submit();
              }
            }}
            onFocus={(e) => {
              // The on-screen keyboard can cover a composer that is already at
              // the bottom of a short viewport. Keep the focused field visible
              // once the browser has resized the visual viewport.
              const field = e.currentTarget;
              const reveal = () => field.scrollIntoView?.({ block: "nearest" });
              reveal();
              if (typeof window !== "undefined" && window.visualViewport) {
                window.visualViewport.addEventListener("resize", reveal, { once: true });
              }
            }}
            placeholder="Сообщение... (Enter — отправить)"
            aria-label="Сообщение"
            aria-controls={composerMentions.listId}
            aria-activedescendant={composerMentions.activeId}
            className={thread ? "order-1 min-h-28 w-full min-w-0 resize-y rounded-md border bg-background px-3 py-3 text-[18px] leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" : "h-11 min-h-11 max-h-40 min-w-0 flex-1 resize-y rounded-md border bg-background px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"}
          />

          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={
              sendMutation.isPending ||
              isError ||
              !draftReady ||
              isUploading ||
              !isConnected ||
              !isJoined ||
              (!draft.trim() && pendingAttachments.length === 0)
            }
            className={thread ? "order-3 min-h-12 shrink-0 gap-2 px-4 text-base" : "h-12 min-w-11 shrink-0 gap-2 px-3"}
            aria-label="Отправить сообщение"
          >
            {sendMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            <span className={thread ? "" : "hidden sm:inline"}>{thread ? "Отправить сообщение" : "Отправить"}</span>
          </Button>
        </div>

        {composerMentions.controls}

        <div role="status" className={`mt-1 text-xs ${draftError ? "text-destructive" : "text-muted-foreground"}`}>
          {draftError ? "Хранилище черновиков недоступно. Изменения могут не сохраниться." : draft ? "Черновик сохранён в этом браузере" : ""}
        </div>
        <div className="text-sm text-muted-foreground mt-1 [@media(max-height:420px)]:hidden">
          Enter: отправить · Shift+Enter: новая строка · Вставка картинок: Ctrl+V
        </div>
      </div>
    </div>
    </>
  );
}
