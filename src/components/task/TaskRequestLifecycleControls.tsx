"use client";

import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { QueryClientContext, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2,
  HelpCircle,
  Loader2,
  RotateCcw,
  Send,
  Trash2,
  UserCheck,
  UserPlus,
  XCircle,
} from "lucide-react";

import { apiDelete, apiFetch, apiPost } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RequestInfoQuestion } from "./RequestInfoQuestion";

export type TaskRequestState =
  | "DRAFT"
  | "SUBMITTED"
  | "IN_PROGRESS"
  | "NEEDS_INFO"
  | "COMPLETED"
  | "CLOSED"
  | "CANCELLED";

export interface TaskLifecycleSnapshot {
  taskId: string;
  projectId: string;
  version: number;
  marked: boolean;
  deleted: boolean;
  state: TaskRequestState | null;
  authorId: string | null;
  executorId: string | null;
  executorName: string | null;
  isPersonal?: boolean;
  beznalPhase?: "WAITING" | "INVOICED" | null;
  workflowKind?: "beznal" | "default";
  invoiceFiles?: Array<{ url: string; name: string }>;
  permissions: {
    isAuthor: boolean;
    isExecutor: boolean;
    isLeader: boolean;
    isGroupMember: boolean;
    canParticipate: boolean;
    canExecute: boolean;
    canAssign: boolean;
    isResponsibleGroupLeader?: boolean;
    canClose?: boolean;
    canEditFields?: boolean;
    canEditDescription?: boolean;
    canSetDeadline?: boolean;
    canUseLegacyAssignees?: boolean;
    canReturnForRevision?: boolean;
    canMarkInvoiceReady?: boolean;
    canApprove?: boolean;
  };
  assignees: Array<{ id: string; name: string | null; email: string }> | null;
  attachments: Array<{ id: string; name: string; size: number; mime: string }>;
}

type DialogKind =
  | "take_over"
  | "assign"
  | "request_info"
  | "answer"
  | "reopen"
  | "cancel"
  | "delete"
  | "return_for_revision"
  | "mark_invoice_ready"
  | "approve"
  | null;

type LifecycleAction =
  | "submit"
  | "take"
  | "take_over"
  | "assign"
  | "request_info"
  | "answer_info"
  | "complete"
  | "close"
  | "reopen"
  | "return_for_revision"
  | "cancel";

type Props = {
  taskId: string;
  projectId: string;
  /** Called after a committed change so the host can refresh its own snapshot. */
  onChanged?: () => void;
  /** Compact presentation of role-specific status and actions. */
  compact?: boolean;
  /** Keep cached permissions separate when the active account changes. */
  actorId?: string;
  disabled?: boolean;
  boardPhase?: { code: string; label: string };
  onReadinessChange?: (ready: boolean) => void;
};

const STATE_LABELS: Record<TaskRequestState, string> = {
  DRAFT: "черновик",
  SUBMITTED: "новое обращение",
  IN_PROGRESS: "в работе",
  NEEDS_INFO: "ждём ответа автора",
  COMPLETED: "решено",
  CLOSED: "закрыто",
  CANCELLED: "отменено",
};

/** Presentation of the existing snapshot only; this never grants an action. */
function requestGuidance(snapshot: TaskLifecycleSnapshot, beznal = false) {
  const { permissions, executorName, state } = snapshot;
  if (snapshot.deleted) return { description: "Обращение удалено из рабочих списков. История сохранена.", nextStep: "Действий с этим обращением нет." };
  if (beznal && ["COMPLETED", "CLOSED"].includes(state ?? "")) return {
    description: "Обращение находится в архиве. Переписка и файлы сохранены.",
    nextStep: permissions.canReturnForRevision ? "Если нужна доработка, нажмите «Вернуть на доработку» и укажите причину." : "Если нужна доработка, обратитесь к автору или отделу продаж.",
  };
  if (beznal && snapshot.beznalPhase === "INVOICED" && ["SUBMITTED", "IN_PROGRESS", "NEEDS_INFO"].includes(state ?? "")) return {
    description: "Счёт подготовлен. Ожидается приёмка заказчиком.",
    nextStep: permissions.canApprove ? "Проверьте результат. Если всё верно, нажмите «Принять и закрыть»; если нужны исправления — «Вернуть на уточнение»." : "Закрыть заявку сможет автор или замещающий его сотрудник продаж после проверки результата.",
  };
  if (beznal && state === "IN_PROGRESS" && permissions.isExecutor) return {
    description: "Вы исполнитель этого обращения.",
    nextStep: "Подготовьте исправления. Прикрепите новый счёт или нажмите «Перевести в «Со счётом»», чтобы выбрать уже прикреплённый документ. Результат примет отдел продаж.",
  };
  if (!snapshot.marked || state === "DRAFT") return {
    description: "Обращение ещё не отправлено в отдел.",
    nextStep: permissions.isAuthor ? "Проверьте описание и отправьте обращение, когда будете готовы." : "Дождитесь отправки обращения автором.",
  };
  if (state === "SUBMITTED") return {
    description: permissions.isAuthor ? "Ваше обращение отправлено в отдел. Специалист пока не назначен." : "Обращение ожидает специалиста. Исполнитель пока не назначен.",
    nextStep: permissions.canExecute ? "Нажмите «Взять в работу». После нажатия вы станете исполнителем этого обращения." : "Дождитесь ответа специалиста. Дополнительные сведения можно написать в обсуждении ниже.",
  };
  if (state === "IN_PROGRESS") return {
    description: permissions.isExecutor ? "Вы исполнитель этого обращения." : executorName ? `${permissions.isAuthor ? "Вашим обращением" : "Обращением"} занимается ${executorName}.` : "Обращением занимается специалист.",
    nextStep: permissions.isExecutor ? "Выполните работу. Затем нажмите «Отметить как решённое»." : permissions.canExecute ? "Если нужно заменить коллегу, нажмите «Взять на себя». После подтверждения вы станете исполнителем." : "Сейчас от вас не требуется действий. Если появились подробности, напишите их в обсуждении ниже.",
  };
  if (state === "NEEDS_INFO") return {
    description: permissions.isAuthor ? "Специалист ждёт ваш ответ." : "Для продолжения работы нужен ответ автора обращения.",
    nextStep: permissions.isAuthor ? "Нажмите «Ответить и вернуть в работу»: напишите ответ или выберите уже прикреплённый файл." : "Дождитесь ответа автора. Обычное сообщение в обсуждении не возвращает обращение в работу.",
  };
  if (state === "COMPLETED") return {
    description: "Специалист отметил обращение как решённое.",
    nextStep: permissions.isAuthor ? "Если проблема осталась, нажмите «Проблема не решена» и укажите причину." : permissions.canClose === true ? "Если обработка завершена, нажмите «Закрыть решённое обращение»." : "Сейчас от вас не требуется действий.",
  };
  if (state === "CLOSED") return {
    description: "Работа по обращению завершена.",
    nextStep: permissions.isAuthor ? "Если проблема осталась, нажмите «Проблема не решена» и укажите причину." : "Сейчас от вас не требуется действий. Историю обращения можно посмотреть ниже.",
  };
  if (state === "CANCELLED") return {
    description: "Обращение отменено. Работа по нему прекращена.",
    nextStep: "Сейчас от вас не требуется действий. Историю обращения можно посмотреть ниже.",
  };
  return { description: "Состояние обращения пока недоступно.", nextStep: "Обновите карточку, чтобы увидеть доступные действия." };
}

function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  const code = (error as { payload?: { error?: { code?: string } } })?.payload?.error?.code;
  if (code === "LIFECYCLE_COLUMNS_REQUIRED" || code === "INVALID_LIFECYCLE_COLUMNS") return "Не удалось определить доступные действия. Обратитесь к администратору.";
  const status = errorStatus(error);
  if (status === 403) return "Недостаточно прав для этого действия.";
  if (status === 404) return "Обращение больше недоступно.";
  if (status === 409) return "Обращение уже изменилось. Обновите карточку и повторите действие.";
  if (status === 422) {
    const message = error instanceof Error ? error.message : "";
    if (/REASON_REQUIRED|reason/i.test(message)) return "Укажите причину.";
    if (/RESPONSE_REQUIRED|response/i.test(message)) return "Добавьте комментарий или файл.";
    if (/ASSIGNEE/i.test(message)) return "Выберите доступного исполнителя.";
    return "Проверьте заполненные поля.";
  }
  return error instanceof Error && error.message
    ? error.message
    : "Не удалось выполнить действие.";
}

function fileName(size: number): string {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

/**
 * The lifecycle snapshot and its cache invalidation need the application query
 * cache. An embedder without one (an isolated panel) gets no controls instead
 * of a crash that would take the whole card down.
 */
export function TaskRequestLifecycleControls(props: Props) {
  const queryClient = useContext(QueryClientContext);
  if (!queryClient) return null;
  return <LifecycleControls key={JSON.stringify([props.actorId, props.projectId, props.taskId])} {...props} />;
}

/**
 * Status-aware controls for the agreed request lifecycle. Every command goes to
 * the canonical POST /api/tasks/[id] lifecycle service; the server re-checks
 * the role, state and version, so hiding a button is only a convenience.
 */
function LifecycleControls({ taskId, projectId, onChanged, compact = false, actorId, disabled = false, boardPhase, onReadinessChange }: Props) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingBusy, setBusy] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [closePhase, setClosePhase] = useState<"idle" | "pending" | "unknown" | "conflict" | "readFailed">("idle");
  const closeIntent = useRef<{ operationId: string; expectedVersion: number; action: "close" } | null>(null);
  const closeRunning = useRef(false);
  const busy = disabled || pendingBusy || refreshFailed || closePhase !== "idle";
  const [selectedAssignee, setSelectedAssignee] = useState<string>("");
  const [reason, setReason] = useState("");
  const [answerText, setAnswerText] = useState("");
  const [answerAttachments, setAnswerAttachments] = useState<string[]>([]);
  const answerClientId = useRef<string | null>(null);
  const [pendingCommentId, setPendingCommentId] = useState<string | null>(null);
  const revisionIntent = useRef<{ operationId: string; expectedVersion: number; action: "return_for_revision"; reason: string } | null>(null);
  const [revisionUnknown, setRevisionUnknown] = useState(false);
  const [invoiceUrl, setInvoiceUrl] = useState("");
  const [preparedUnknown, setPreparedUnknown] = useState(false);
  const preparedIntent = useRef<{ operationId: string; expectedVersion: number; action: "approve" | "mark_invoice_ready"; invoiceUrl?: string } | null>(null);

  const snapshotQuery = useQuery({
    queryKey: actorId ? ["task-lifecycle", taskId, actorId] : ["task-lifecycle", taskId],
    queryFn: () => apiFetch<TaskLifecycleSnapshot>(`/api/tasks/${taskId}/lifecycle`),
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const command = useMutation({
    mutationFn: (body: {
      action: LifecycleAction;
      assigneeId?: string;
      reason?: string;
      response?: { commentId?: string; attachmentId?: string };
    }) =>
      apiPost<{ taskId: string; version: number; state: TaskRequestState }>(
        `/api/tasks/${taskId}`,
        {
          operationId: crypto.randomUUID(),
          expectedVersion: snapshotQuery.data?.version ?? 0,
          ...body,
        },
      ),
  });

  const snapshot = snapshotQuery.data;
  useEffect(() => {
    onReadinessChange?.(snapshotQuery.isFetchedAfterMount && !snapshotQuery.isFetching && !snapshotQuery.isError && Boolean(snapshot));
    return () => onReadinessChange?.(false);
  }, [onReadinessChange, snapshotQuery.isFetchedAfterMount, snapshotQuery.isFetching, snapshotQuery.isError, snapshot]);

  const resetDialog = () => {
    setDialog(null);
    setError(null);
    setSelectedAssignee("");
    setInvoiceUrl(""); setPreparedUnknown(false); preparedIntent.current = null;
    setReason("");
    setAnswerText("");
    setAnswerAttachments([]);
    setPendingCommentId(null);
    answerClientId.current = null;
    revisionIntent.current = null;
    setRevisionUnknown(false);
  };

  const refresh = async () => {
    // These reads are independent. Refetch the actual observer explicitly:
    // invalidating an inactive/disabled query alone would not prove fresh rights.
    const lifecycle = snapshotQuery.refetch({ cancelRefetch: true });
    // List/history convergence is independent of the fresh command authority.
    // Start both now, but neither is on the next action's critical path.
    void Promise.allSettled([
      Promise.resolve().then(() => queryClient.invalidateQueries({ queryKey: ["tasks", projectId] })),
      Promise.resolve().then(() => queryClient.invalidateQueries({ queryKey: ["activities", taskId] })),
      Promise.resolve().then(() => queryClient.invalidateQueries({ queryKey: ["task-messages", taskId] })),
    ]);
    let fresh = false;
    try { fresh = !(await lifecycle).isError; } catch { /* Only a fresh read can release mutation controls. */ }
    // Host/list refresh failures cannot turn an acknowledged mutation into a
    // failed command, or trigger a replay of that committed operation.
    try { void Promise.resolve(onChanged?.()).catch(() => undefined); } catch { /* Committed outcome stays committed. */ }
    return fresh;
  };

  const refreshAfterCommit = async () => {
    const fresh = await refresh();
    setRefreshFailed(!fresh);
    if (!fresh) setError("Изменение сохранено. Не удалось загрузить актуальное состояние обращения. Обновите карточку.");
  };

  const retryCommittedRead = async () => {
    if (pendingBusy) return;
    setBusy(true);
    try {
      const result = await snapshotQuery.refetch({ cancelRefetch: true });
      if (!result.isError) { setRefreshFailed(false); setError(null); }
    } finally { setBusy(false); }
  };

  const run = async (
    body: {
      action: LifecycleAction;
      assigneeId?: string;
      reason?: string;
    },
    successMessage: string,
  ) => {
    setBusy(true);
    setError(null);
    try {
      await command.mutateAsync(body);
      resetDialog();
      await refreshAfterCommit();
      toast.success(successMessage);
    } catch (caught) {
      if (errorStatus(caught) === 409) await snapshotQuery.refetch();
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const returnForRevision = async () => {
    if (busy || !snapshot || (!revisionIntent.current && !reason.trim())) return;
    const intent = revisionIntent.current ?? { operationId: crypto.randomUUID(), expectedVersion: snapshot.version,
      action: "return_for_revision" as const, reason: reason.trim() };
    revisionIntent.current = intent; setBusy(true); setError(null);
    try {
      await apiPost(`/api/tasks/${taskId}`, intent);
      resetDialog(); await refreshAfterCommit();
      toast.success("Обращение возвращено в «Ждут обработки»");
    } catch (caught) {
      const status = errorStatus(caught);
      const unknown = status === undefined || status >= 500;
      setRevisionUnknown(unknown);
      if (!unknown) revisionIntent.current = null;
      if (status === 409) await snapshotQuery.refetch();
      setError(unknown ? "Сервер пока не подтвердил возврат. Повторите тот же возврат, чтобы проверить результат." : errorMessage(caught));
    } finally { setBusy(false); }
  };

  const commitPreparedResult = async (action: "approve" | "mark_invoice_ready") => {
    if (busy || !snapshot || (action === "mark_invoice_ready" && !preparedIntent.current && !invoiceUrl)) return;
    const intent = preparedIntent.current ?? { operationId: crypto.randomUUID(), expectedVersion: snapshot.version, action,
      ...(action === "mark_invoice_ready" ? { invoiceUrl } : {}) };
    preparedIntent.current = intent; setBusy(true); setError(null);
    try {
      await apiPost(`/api/tasks/${taskId}`, intent);
      resetDialog(); await refreshAfterCommit();
      toast.success(action === "approve" ? "Результат принят. Обращение закрыто" : "Обращение переведено в «Со счётом»");
    } catch (caught) {
      const status = errorStatus(caught), unknown = status === undefined || status >= 500;
      setPreparedUnknown(unknown);
      if (!unknown) preparedIntent.current = null;
      if (status === 409) await snapshotQuery.refetch();
      setError(unknown ? "Сервер пока не подтвердил действие. Повторите тот же запрос, чтобы проверить результат." : errorMessage(caught));
    } finally { setBusy(false); }
  };

  const readClosed = async () => {
    if (closeRunning.current) return;
    closeRunning.current = true;
    try {
      const result = await snapshotQuery.refetch();
      if (result.isError) { setClosePhase("readFailed"); setError("Не удалось загрузить актуальное состояние обращения. Обновите карточку."); }
      else { setClosePhase("idle"); setError(null); closeIntent.current = null; }
    } finally { closeRunning.current = false; }
  };
  const closeRequest = async () => {
    if (closeRunning.current || !snapshot) return;
    closeIntent.current ??= { operationId: crypto.randomUUID(), expectedVersion: snapshot.version, action: "close" };
    closeRunning.current = true; setClosePhase("pending"); setError(null);
    let committed = false;
    try {
      await apiPost(`/api/tasks/${taskId}`, closeIntent.current);
      committed = true; closeIntent.current = null;
      toast.success("Обращение закрыто");
      const fresh = await refresh();
      if (!fresh) { setClosePhase("readFailed"); setError("Обращение закрыто. Не удалось загрузить актуальные данные. Обновите карточку."); }
      else setClosePhase("idle");
    } catch (caught) {
      if (committed) { setClosePhase("readFailed"); setError("Обращение закрыто. Обновите карточку, чтобы загрузить актуальные данные."); }
      else if ([400, 401, 403, 404, 409, 413, 422, 429].includes(errorStatus(caught) ?? 0)) {
        closeIntent.current = null; setClosePhase("conflict"); setError(errorMessage(caught));
      } else { setClosePhase("unknown"); setError("Сервер не подтвердил закрытие обращения. Нажмите «Повторить закрытие», чтобы проверить результат той же команды."); }
    } finally { closeRunning.current = false; }
  };

  const submitAnswer = async () => {
    if (!snapshot) return;
    const text = answerText.trim();
    if (!text && answerAttachments.length === 0) {
      setError("Добавьте комментарий или выберите файл.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let commentId = pendingCommentId;
      if (commentId === null) {
        const attachments = (snapshot.attachments ?? [])
          .filter((attachment) => answerAttachments.includes(attachment.id))
          .map((attachment) => ({
            url: `/api/tasks/${taskId}/files/${attachment.id}`,
            name: attachment.name,
            size: attachment.size,
            mime: attachment.mime,
          }));
        // The ordinary comment is created first; it never clears the pause by
        // itself. The explicit answer below is the only transition.
        answerClientId.current ??= crypto.randomUUID();
        const message = await apiPost<{ id: string }>(`/api/tasks/${taskId}/messages`, {
          clientId: answerClientId.current,
          contentText: text,
          attachments,
        });
        commentId = message.id;
        setPendingCommentId(commentId);
      }
      await command.mutateAsync({
        action: "answer_info",
        response: {
          commentId,
          ...(answerAttachments[0] ? { attachmentId: answerAttachments[0] } : {}),
        },
      });
      resetDialog();
      await refreshAfterCommit();
      toast.success("Ответ отправлен, обращение возвращено в работу");
    } catch (caught) {
      if (errorStatus(caught) === 409) await snapshotQuery.refetch();
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const removeTask = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`/api/tasks/${taskId}`);
      resetDialog();
      await refreshAfterCommit();
      toast.success("Обращение удалено из рабочих списков");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  if (snapshotQuery.isLoading) {
    if (compact) return <p role="status" className="text-xs text-muted-foreground">Загрузка действий…</p>;
    return (
      <section
        aria-label="Состояние обращения"
        className="rounded-lg border bg-card p-3 text-sm text-muted-foreground shadow-sm"
      >
        Загружаем состояние обращения…
      </section>
    );
  }

  if (!snapshot || !snapshot.permissions) {
    if (errorStatus(snapshotQuery.error) === 404) return null;
    return (
      <section
        aria-label={compact ? "Действия обращения" : "Состояние обращения"}
        className={compact ? "text-sm" : "rounded-lg border bg-card p-3 text-sm shadow-sm"}
      >
        <p role="alert" className="text-destructive">
          Не удалось загрузить состояние обращения.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => void snapshotQuery.refetch()}
        >
          Повторить
        </Button>
      </section>
    );
  }

  const { permissions } = snapshot;
  const isTransfer = Boolean(snapshot.executorId);
  const assignmentLabel = isTransfer ? "Передать другому исполнителю" : "Назначить исполнителя";
  const assignmentCandidates = (snapshot.assignees ?? []).filter(candidate => candidate.id !== snapshot.executorId);
  const state = snapshot.state;
  const isDraft = state === "DRAFT" || (!snapshot.marked && state === null);
  const isSubmitted = state === "SUBMITTED";
  const isInProgress = state === "IN_PROGRESS";
  const isNeedsInfo = state === "NEEDS_INFO";
  const isCompleted = state === "COMPLETED";
  const statusLabel = snapshot.deleted ? "удалено" : isDraft ? STATE_LABELS.DRAFT
    : isNeedsInfo && permissions.isAuthor ? "ждём вашего ответа" : state === null ? "неизвестен" : STATE_LABELS[state];
  const presentedLabel = !snapshot.deleted && !isDraft && boardPhase
    ? ["CLOSED", "COMPLETED", "CANCELLED"].includes(state ?? "") ? "Закрыто"
      : snapshot.beznalPhase === "WAITING" ? "Ждут обработки" : snapshot.beznalPhase === "INVOICED" ? "Со счётом" : boardPhase.label
    : statusLabel;
  const beznal = snapshot.workflowKind === "beznal" || Boolean(boardPhase);
  const guidance = requestGuidance(snapshot, beznal);

  const actions: ReactNode[] = [];
  const buttonClass = "h-auto min-h-11 whitespace-normal px-4 py-2 text-base leading-6";
  if (permissions.canReturnForRevision === true) {
    actions.push(<Button key="return-for-revision" type="button" variant="outline" className={buttonClass} disabled={busy}
      onClick={() => { setError(null); setDialog("return_for_revision"); }}><RotateCcw className="mr-1 h-4 w-4"/>{isCompleted || state === "CLOSED" ? "Вернуть на доработку" : "Вернуть на уточнение"}</Button>);
  }
  if (permissions.canMarkInvoiceReady) actions.push(<Button key="invoice-ready" type="button" className={buttonClass} disabled={busy} onClick={() => { setError(null); setInvoiceUrl(snapshot.invoiceFiles?.length === 1 ? snapshot.invoiceFiles[0].url : ""); setDialog("mark_invoice_ready"); }}><CheckCircle2 className="mr-1 h-4 w-4"/>Перевести в «Со счётом»</Button>);
  if (permissions.canApprove) actions.push(<Button key="approve" type="button" className={buttonClass} disabled={busy} onClick={() => { setError(null); setDialog("approve"); }}><CheckCircle2 className="mr-1 h-4 w-4"/>Принять и закрыть</Button>);

  if (isDraft && permissions.isAuthor) {
    actions.push(
      <Button
        key="submit"
        type="button"
        size="sm"
        className={buttonClass}
        disabled={busy}
        onClick={() => void run({ action: "submit" }, "Обращение отправлено в отдел")}
      >
        <Send className="mr-1 h-4 w-4" />
        Отправить обращение
      </Button>,
    );
    actions.push(
      <Button
        key="delete-draft"
        type="button"
        size="sm"
        variant="outline"
        className={buttonClass}
        disabled={busy}
        onClick={() => { setError(null); setDialog("delete"); }}
      >
        <Trash2 className="mr-1 h-4 w-4" />
        Удалить черновик
      </Button>,
    );
  }

  if (isSubmitted) {
    if (permissions.canExecute) {
      actions.push(
        <Button
          key="take"
          type="button"
          size="sm"
          className={buttonClass}
          disabled={busy}
          onClick={() => void run({ action: "take" }, "Обращение взято в работу")}
        >
          <UserCheck className="mr-1 h-4 w-4" />
          Взять в работу
        </Button>,
      );
    }
    if (permissions.canAssign) {
      actions.push(
        <Button
          key="assign"
          type="button"
          size="sm"
          variant="outline"
          className={buttonClass}
          disabled={busy}
          onClick={() => { setError(null); setDialog("assign"); }}
        >
          <UserPlus className="mr-1 h-4 w-4" />
          {assignmentLabel}
        </Button>,
      );
    }
    if (permissions.isAuthor) {
      actions.push(
        <Button
          key="cancel"
          type="button"
          size="sm"
          variant="outline"
          className={buttonClass}
          disabled={busy}
          onClick={() => { setError(null); setDialog("cancel"); }}
        >
          <XCircle className="mr-1 h-4 w-4" />
          Отменить обращение
        </Button>,
      );
      actions.push(
        <Button
          key="delete"
          type="button"
          size="sm"
          variant="destructive"
          className={buttonClass}
          disabled={busy}
          onClick={() => { setError(null); setDialog("delete"); }}
        >
          <Trash2 className="mr-1 h-4 w-4" />
          Удалить как ошибочную
        </Button>,
      );
    }
  }

  if ((isInProgress || isNeedsInfo) && permissions.canExecute && !permissions.isExecutor && snapshot.executorId) {
    actions.push(
      <Button key="take-over" type="button" size="sm" className={buttonClass} disabled={busy}
        onClick={() => { setError(null); setDialog("take_over"); }}>
        <UserCheck className="mr-1 h-4 w-4" />
        Взять на себя
      </Button>,
    );
  }

  if (isInProgress) {
    if (permissions.isExecutor || permissions.isLeader) {
      actions.push(
        <Button
          key="request-info"
          type="button"
          size="sm"
          variant="outline"
          className={buttonClass}
          disabled={busy}
          onClick={() => { setError(null); setDialog("request_info"); }}
        >
          <HelpCircle className="mr-1 h-4 w-4" />
          Задать вопрос автору
        </Button>,
      );
    }
    if (permissions.isExecutor && !beznal) {
      actions.push(
        <Button
          key="complete"
          type="button"
          size="sm"
          className={buttonClass}
          disabled={busy}
          onClick={() => void run({ action: "complete" }, "Обращение отмечено как решённое")}
        >
          <CheckCircle2 className="mr-1 h-4 w-4" />
          Отметить как решённое
        </Button>,
      );
    }
    if (permissions.canAssign) {
      actions.push(
        <Button
          key="assign"
          type="button"
          size="sm"
          variant="outline"
          className={buttonClass}
          disabled={busy}
          onClick={() => { setError(null); setDialog("assign"); }}
        >
          <UserPlus className="mr-1 h-4 w-4" />
          {assignmentLabel}
        </Button>,
      );
    }
    if (permissions.isExecutor || permissions.isLeader) {
      actions.push(
        <Button
          key="cancel"
          type="button"
          size="sm"
          variant="outline"
          className={buttonClass}
          disabled={busy}
          onClick={() => { setError(null); setDialog("cancel"); }}
        >
          <XCircle className="mr-1 h-4 w-4" />
          Отменить обращение
        </Button>,
      );
      actions.push(
        <Button
          key="delete"
          type="button"
          size="sm"
          variant="destructive"
          className={buttonClass}
          disabled={busy}
          onClick={() => { setError(null); setDialog("delete"); }}
        >
          <Trash2 className="mr-1 h-4 w-4" />
          Удалить как ошибочную
        </Button>,
      );
    }
  }

  if (isNeedsInfo) {
    if (permissions.isAuthor) {
      actions.push(
        <Button
          key="answer"
          type="button"
          size="sm"
          className={buttonClass}
          disabled={busy}
          onClick={() => { setError(null); setDialog("answer"); }}
        >
          <Send className="mr-1 h-4 w-4" />
          Ответить и вернуть в работу
        </Button>,
      );
    }
    if (permissions.canAssign) {
      actions.push(
        <Button
          key="assign"
          type="button"
          size="sm"
          variant="outline"
          className={buttonClass}
          disabled={busy}
          onClick={() => { setError(null); setDialog("assign"); }}
        >
          <UserPlus className="mr-1 h-4 w-4" />
          {assignmentLabel}
        </Button>,
      );
    }
    if (permissions.isExecutor || permissions.isLeader) {
      actions.push(
        <Button
          key="cancel"
          type="button"
          size="sm"
          variant="outline"
          className={buttonClass}
          disabled={busy}
          onClick={() => { setError(null); setDialog("cancel"); }}
        >
          <XCircle className="mr-1 h-4 w-4" />
          Отменить обращение
        </Button>,
      );
      actions.push(
        <Button
          key="delete"
          type="button"
          size="sm"
          variant="destructive"
          className={buttonClass}
          disabled={busy}
          onClick={() => { setError(null); setDialog("delete"); }}
        >
          <Trash2 className="mr-1 h-4 w-4" />
          Удалить как ошибочную
        </Button>,
      );
    }
  }

  if (!beznal && isCompleted && permissions.canClose === true) {
    actions.push(<Button key="close" type="button" size="sm" className={buttonClass} disabled={busy} onClick={() => void closeRequest()}><CheckCircle2 className="mr-1 h-4 w-4" />Закрыть решённое обращение</Button>);
  }
  if (!beznal && (isCompleted || state === "CLOSED") && permissions.isAuthor) {
    actions.push(
      <Button
        key="reopen"
        type="button"
        size="sm"
        variant="outline"
        className={buttonClass}
        disabled={busy}
        onClick={() => { setError(null); setDialog("reopen"); }}
      >
        <RotateCcw className="mr-1 h-4 w-4" />
        Проблема не решена
      </Button>,
    );
  }

  const allowedActions = beznal && !permissions.isAuthor ? actions.filter(action => !["cancel", "delete"].includes(String((action as { key?: string }).key))) : actions;
  const displayedActions = snapshot.deleted ? [] : compact ? allowedActions.filter(action =>
    String((action as { key?: string }).key) !== "delete") : allowedActions;
  const primaryActions = displayedActions.filter(action => String((action as { key?: string }).key) !== "cancel");
  const cancelActions = displayedActions.filter(action => String((action as { key?: string }).key) === "cancel");

  return (
    <section
      aria-label="Состояние и действия обращения"
      className={cn(
        "space-y-4 rounded-lg border p-4 text-base leading-6",
        !compact && "bg-card shadow-sm",
        compact && "bg-muted/30",
      )}
    >
      <div className="space-y-2">
        {snapshot.isPersonal && <p className="font-semibold text-primary">Персональная заявка · доступ ограничен</p>}
        <h3 className="font-semibold">Статус: {presentedLabel}</h3>
        <p>{guidance.description}</p>
        <p><span className="font-semibold">Что делать сейчас:</span> {guidance.nextStep}</p>
      </div>
      {snapshot.state === "NEEDS_INFO" && !snapshot.deleted
        && snapshotQuery.isFetchedAfterMount && !snapshotQuery.isFetching && !snapshotQuery.isError
        && (snapshot.permissions.canParticipate || snapshot.permissions.isAuthor || snapshot.permissions.isExecutor)
        && <RequestInfoQuestion key={JSON.stringify([taskId, actorId, snapshot.version])} taskId={taskId} actorId={actorId} version={snapshot.version} />}
      {primaryActions.length > 0 && <div className="flex flex-wrap gap-2">{primaryActions}</div>}
      {cancelActions.length > 0 && <div className="space-y-2 border-t pt-3">
        <p className="text-sm text-muted-foreground">Помощь больше не нужна?</p>
        <div className="flex flex-wrap gap-2">{cancelActions}</div>
      </div>}
      {disabled && <p className="text-sm text-muted-foreground">Действия временно недоступны. Следуйте сообщению о сохранении выше.</p>}
      {pendingBusy && <p role="status" className="text-sm text-muted-foreground">Выполняем действие…</p>}

      {error && dialog === null && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {refreshFailed && <Button type="button" variant="outline" disabled={pendingBusy} onClick={() => void retryCommittedRead()}>Обновить карточку</Button>}
      {closePhase === "pending" && <p role="status" className="mt-2 text-sm">Закрываем обращение…</p>}
      {closePhase === "unknown" && <Button type="button" variant="outline" onClick={() => void closeRequest()}>Повторить закрытие</Button>}
      {(closePhase === "conflict" || closePhase === "readFailed") && <Button type="button" variant="outline" onClick={() => void readClosed()}>Обновить карточку</Button>}

      <Dialog open={dialog === "mark_invoice_ready" || dialog === "approve"} onOpenChange={open => { if (!open && !busy && !preparedUnknown) resetDialog(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{dialog === "approve" ? "Принять результат и закрыть заявку?" : "Перевести заявку в «Со счётом»"}</DialogTitle><DialogDescription>{dialog === "approve" ? "Подтвердите, что счёт и результат проверены. Заявка перейдёт в архив; при необходимости её можно вернуть на доработку с причиной." : "Выберите готовый документ из опубликованных файлов заявки. После подтверждения отдел продаж сможет проверить результат."}</DialogDescription></DialogHeader>
          {dialog === "mark_invoice_ready" && <div className="space-y-3">{snapshot.invoiceFiles?.length ? <fieldset className="space-y-2"><legend className="font-medium">Готовый документ</legend>{snapshot.invoiceFiles.map(file => <label key={file.url} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border p-3"><input type="radio" name={`${taskId}-invoice-ready`} checked={invoiceUrl === file.url} disabled={busy || preparedUnknown} onChange={() => setInvoiceUrl(file.url)}/><span className="break-all">{file.name}</span></label>)}</fieldset> : <p>Сначала прикрепите счёт к заявке. Неотправленные и внутренние файлы здесь не показываются.</p>}</div>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy || preparedUnknown} onClick={resetDialog}>Вернуться</Button><Button type="button" disabled={busy || (dialog === "mark_invoice_ready" && !invoiceUrl && !preparedUnknown)} onClick={() => void commitPreparedResult(dialog === "approve" ? "approve" : "mark_invoice_ready")}>{preparedUnknown ? "Повторить тот же запрос" : dialog === "approve" ? "Подтвердить приёмку и закрыть" : "Подтвердить: со счётом"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "take_over"} onOpenChange={(open) => { if (!open && !busy) resetDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Взять обращение на себя?</DialogTitle>
            <DialogDescription>
              Сейчас исполнитель: {snapshot.executorName || "назначенный сотрудник"}. После подтверждения исполнителем станете вы. Текущий статус, вопрос автору и сроки сохранятся.
            </DialogDescription>
          </DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={resetDialog}>Вернуться</Button>
            <Button type="button" disabled={busy || !permissions.canExecute || permissions.isExecutor || !(isInProgress || isNeedsInfo)}
              onClick={() => void run({ action: "take_over" }, "Теперь вы исполнитель обращения")}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Подтвердить: взять на себя
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "assign"} onOpenChange={(open) => { if (!open && !busy) resetDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{assignmentLabel}</DialogTitle>
            <DialogDescription>
              {isTransfer ? `Сейчас исполнитель: ${snapshot.executorName || "назначенный сотрудник"}. Выберите, кому передать обращение. После подтверждения исполнителем станет выбранный сотрудник.` : "У обращения будет один исполнитель. Выберите сотрудника из доступного списка."}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {assignmentCandidates.length === 0 && (
              <p className="text-sm text-muted-foreground">{isTransfer ? "Других доступных исполнителей для этого обращения нет. Обратитесь к руководителю отдела." : "Нет доступных исполнителей. Обратитесь к руководителю отдела."}</p>
            )}
            {assignmentCandidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                aria-pressed={selectedAssignee === candidate.id}
                className={cn(
                  "flex w-full min-w-0 items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm",
                  selectedAssignee === candidate.id
                    ? "border-primary bg-primary/10"
                    : "hover:bg-accent",
                )}
                onClick={() => setSelectedAssignee(candidate.id)}
              >
                <span className="min-w-0 truncate">
                  {candidate.name || candidate.email}
                </span>
                {selectedAssignee === candidate.id && <UserCheck className="h-4 w-4 shrink-0" />}
              </button>
            ))}
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={resetDialog}>
              Вернуться
            </Button>
            <Button
              type="button"
              disabled={busy || !permissions.canAssign || !assignmentCandidates.some(candidate => candidate.id === selectedAssignee)}
              onClick={() => void run(
                { action: "assign", assigneeId: selectedAssignee },
                isTransfer ? "Обращение передано другому исполнителю" : "Исполнитель назначен",
              )}
            >
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {isTransfer ? "Передать обращение" : "Назначить"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "request_info"} onOpenChange={(open) => { if (!open && !busy) resetDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Задать вопрос автору</DialogTitle>
            <DialogDescription>
              Обращение будет ждать ответа автора. Исполнитель сохранится. Напишите, какие сведения нужны для продолжения работы.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`${taskId}-request-info`}>Ваш вопрос автору (необязательно)</Label>
            <Textarea
              id={`${taskId}-request-info`}
              value={reason}
              maxLength={2000}
              rows={4}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Опишите, какие сведения нужны автору"
            />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={resetDialog}>
              Вернуться
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void run(
                { action: "request_info", ...(reason.trim() ? { reason: reason.trim() } : {}) },
                "Уточнение запрошено",
              )}
            >
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Отправить вопрос
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "answer"} onOpenChange={(open) => { if (!open && !busy) resetDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ответить и вернуть в работу</DialogTitle>
            <DialogDescription>
              Напишите ответ или выберите уже прикреплённый файл. После отправки обращение вернётся в работу. Обычное сообщение в обсуждении этого не делает.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor={`${taskId}-answer`}>Ответ исполнителю</Label>
              <Textarea
                id={`${taskId}-answer`}
                value={answerText}
                maxLength={20000}
                rows={4}
                onChange={(event) => setAnswerText(event.target.value)}
                placeholder="Добавьте пояснение"
              />
            </div>
            {(snapshot.attachments ?? []).length > 0 && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Прикреплённые файлы</legend>
                {(snapshot.attachments ?? []).map((attachment) => (
                  <label
                    key={attachment.id}
                    className="flex min-w-0 items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={answerAttachments.includes(attachment.id)}
                      onCheckedChange={(checked) =>
                        setAnswerAttachments((current) =>
                          checked === true
                            ? [...current, attachment.id]
                            : current.filter((id) => id !== attachment.id),
                        )}
                    />
                    <span className="min-w-0 truncate">{attachment.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {fileName(attachment.size)}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={resetDialog}>
              Вернуться
            </Button>
            <Button
              type="button"
              disabled={busy || (answerText.trim().length === 0 && answerAttachments.length === 0)}
              onClick={() => void submitAnswer()}
            >
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Ответить и вернуть в работу
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "reopen"} onOpenChange={(open) => { if (!open && !busy) resetDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Проблема не решена</DialogTitle>
            <DialogDescription>
              Укажите, что осталось нерешённым. Обращение вернётся прежнему исполнителю, если он доступен, или в очередь отдела. Причина обязательна.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`${taskId}-reopen`}>Почему проблема не решена</Label>
            <Textarea
              id={`${taskId}-reopen`}
              value={reason}
              maxLength={2000}
              rows={4}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Что осталось нерешённым"
            />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={resetDialog}>
              Вернуться
            </Button>
            <Button
              type="button"
              disabled={busy || reason.trim().length === 0}
              onClick={() => void run(
                { action: "reopen", reason: reason.trim() },
                "Обращение возвращено в работу",
              )}
            >
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Проблема не решена
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "return_for_revision"} onOpenChange={open => { if (!open && !busy && !revisionUnknown) resetDialog(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Вернуть на уточнение</DialogTitle><DialogDescription>Обращение перейдёт в «Ждут обработки». Исполнитель и прежние файлы сохранятся. Укажите, что нужно поправить.</DialogDescription></DialogHeader>
          <div className="space-y-2"><Label htmlFor={`${taskId}-revision`}>Что нужно поправить</Label><Textarea id={`${taskId}-revision`} value={reason} maxLength={2000} rows={4} disabled={busy || revisionUnknown} onChange={event => setReason(event.target.value)} placeholder="Опишите необходимые исправления"/></div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy || revisionUnknown} onClick={resetDialog}>Вернуться</Button>
            <Button type="button" disabled={busy || !reason.trim()} onClick={() => void returnForRevision()}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin"/>}{revisionUnknown ? "Повторить возврат" : "Вернуть в «Ждут обработки»"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "cancel"} onOpenChange={(open) => { if (!open && !busy) resetDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Отменить обращение?</DialogTitle>
            <DialogDescription>
              Обращение будет отмечено как отменённое. Оно больше не будет ожидать выполнения. История обращения сохранится; обращение можно будет найти в архиве.
            </DialogDescription>
          </DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={resetDialog}>
              Не отменять обращение
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void run({ action: "cancel" }, "Обращение отменено")}
            >
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Да, отменить обращение
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "delete"} onOpenChange={(open) => { if (!open && !busy) resetDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Удалить ошибочное обращение</DialogTitle>
            <DialogDescription>
              Обращение исчезнет из рабочих списков. История сохранится.
              Если помощь больше не нужна, используйте отмену обращения.
            </DialogDescription>
          </DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={resetDialog}>
              Оставить
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void removeTask()}
            >
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Удалить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
