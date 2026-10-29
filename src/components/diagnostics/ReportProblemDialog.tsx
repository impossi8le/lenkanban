"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { apiPost } from "@/lib/api";
import { PROBLEM_REPORT_COMMENT_MAX } from "@/lib/problem-report-comment-contract";
import { getBrowserTelemetryClient, ProblemReportFailure, type ProblemReportDraft, type ProblemReportReceipt } from "@/lib/telemetry/client";
import type { ProblemReportReason } from "@/lib/telemetry/problem-report-contract";
import type { TelemetryScreen } from "@/lib/telemetry/catalog";

import { problemReportReasons } from "./problem-report-labels";

export function ReportProblemDialog({ open, onOpenChange, screen, returnFocusRef }: {
  open: boolean; onOpenChange: (open: boolean) => void; screen: TelemetryScreen;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [reason, setReason] = useState<ProblemReportReason>("slow");
  const [comment, setComment] = useState("");
  const commentId = useId();
  const frozenComment = useRef<string | null>(null);
  const acknowledged = useRef<ProblemReportReceipt | null>(null);
  const [draft, setDraft] = useState<ProblemReportDraft | null>(null);
  const intent = useRef<ProblemReportDraft | null>(null);
  const [receipt, setReceipt] = useState<ProblemReportReceipt | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(0);
  const alive = useRef(true);
  const generation = useRef(0);
  const sending = useRef(false);
  useEffect(() => {
    alive.current = true;
    const invalidate = () => { generation.current++; };
    const client = getBrowserTelemetryClient();
    const unsubscribe = client?.subscribeSessionChange(() => {
      invalidate(); intent.current = null; sending.current = false; frozenComment.current = null; acknowledged.current = null; setComment("");
      setDraft(null); setReceipt(null); setPending(false); setError("Диагностическая сессия изменилась. Откройте сообщение заново."); setPreview(0);
    });
    return () => { alive.current = false; invalidate(); unsubscribe?.(); };
  }, []);
  useEffect(() => { if (open && !intent.current) setPreview(getBrowserTelemetryClient()?.getBreadcrumbSnapshot().length ?? 0); }, [open]);

  const send = async () => {
    if (sending.current || receipt) return;
    const client = getBrowserTelemetryClient();
    const next = intent.current ?? client?.prepareProblemReport(reason, screen);
    if (!client || !next) { setError("Диагностика сейчас недоступна. Повторите попытку немного позже."); return; }
    if (frozenComment.current === null) frozenComment.current = comment.trim() ? comment : "";
    intent.current = next; setDraft(next); setPreview(next.breadcrumbCount);
    sending.current = true; setPending(true); setError(null);
    const current = generation.current;
    try {
      const confirmed = acknowledged.current ?? await client.sendProblemReport(next);
      if (!alive.current || current !== generation.current) return;
      acknowledged.current = confirmed;
      if (frozenComment.current) {
        const saved = await apiPost<{ reportId: string }>(`/api/problem-reports/${encodeURIComponent(confirmed.reportId)}/comment`, { comment: frozenComment.current });
        if (saved.reportId !== confirmed.reportId) throw new Error("COMMENT_ACK_UNCONFIRMED");
      }
      if (alive.current && current === generation.current) { setReceipt(confirmed); setComment(""); }
    } catch (caught) {
      if (!alive.current || current !== generation.current) return;
      if (caught instanceof ProblemReportFailure && caught.code === "changed") {
        intent.current = null; setDraft(null); setError("Диагностическая сессия изменилась. Откройте сообщение заново.");
      } else setError(acknowledged.current ? "Отчёт принят, но сохранение комментария не подтверждено. Повторите отправку — текст и номер сообщения сохранятся." : "Не удалось подтвердить отправку. Нажмите «Повторить отправку» — повтор сохранит тот же номер сообщения.");
    } finally {
      if (alive.current && current === generation.current) { sending.current = false; setPending(false); }
    }
  };
  const fresh = () => { if (sending.current) return; generation.current++; intent.current = null; frozenComment.current = null; acknowledged.current = null; setComment(""); setDraft(null); setReceipt(null); setError(null); setCopied(false); setPreview(getBrowserTelemetryClient()?.getBreadcrumbSnapshot().length ?? 0); };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-md" onCloseAutoFocus={event => { event.preventDefault(); returnFocusRef.current?.focus(); }}>
    <DialogTitle>Сообщить о проблеме</DialogTitle>
    <DialogDescription>Отправим технические сведения и последние действия текущей сессии. Ваш комментарий увидит администратор.</DialogDescription>
    {receipt ? <div role="status" className="space-y-3"><p className="font-semibold">Отчёт отправлен</p><p>Номер сообщения:</p><code className="block break-all rounded bg-muted p-3">{receipt.reportId}</code>
      <Button variant="outline" className="min-h-11 w-full" onClick={() => void navigator.clipboard?.writeText(receipt.reportId).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? "Номер скопирован" : "Скопировать номер"}</Button>
      <Button variant="outline" className="min-h-11 w-full" onClick={fresh}>Новое сообщение</Button></div>
      : <><fieldset disabled={pending || Boolean(draft)} className="space-y-2"><legend className="mb-2 font-semibold">Что произошло?</legend>{problemReportReasons.map(item => <label key={item.value} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border p-3"><input type="radio" name="problem-reason" value={item.value} checked={reason === item.value} onChange={() => setReason(item.value)} />{item.label}</label>)}</fieldset>
      <div className="space-y-2"><Label htmlFor={commentId}>Комментарий (необязательно)</Label><Textarea id={commentId} value={comment} onChange={event => setComment(event.target.value)} maxLength={PROBLEM_REPORT_COMMENT_MAX} rows={4} disabled={pending || Boolean(draft)} placeholder="Опишите, что произошло и чего вы ожидали" /><p className="text-sm text-muted-foreground">До {PROBLEM_REPORT_COMMENT_MAX} символов. Не указывайте пароли и платёжные данные.</p></div>
      <p className="text-sm text-muted-foreground">Последних технических действий: {preview}.{draft?.truncated ? " Контекст сокращён до допустимого размера." : ""}</p>
      {error && <><p role="alert" className="text-sm text-destructive">{error}</p><p className="text-sm text-muted-foreground">Предыдущая попытка могла сохраниться, даже если подтверждение не получено. Повтор сохраняет прежний номер; новое сообщение создаётся только по вашему выбору.</p><Button variant="outline" className="min-h-11 w-full" disabled={pending} onClick={fresh}>Начать новое сообщение</Button></>}
      <Button className="min-h-11 w-full" disabled={pending} onClick={() => void send()}>{pending ? "Отправляем…" : draft ? "Повторить отправку" : "Отправить сообщение"}</Button></>}
    <Button variant="outline" className="min-h-11 w-full" onClick={() => onOpenChange(false)}>Закрыть окно</Button>
  </DialogContent></Dialog>;
}
