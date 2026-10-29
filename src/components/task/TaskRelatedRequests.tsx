"use client";
import {SearchHighlight} from "@/components/ui/SearchHighlight";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, Link2, Loader2, Search } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {getRequestBoardPhase} from "@/lib/request-board-phase";
import {isBeznalProject,isClaimProject} from "@/lib/request-presentation";
import { readableSearchDescription, searchSnippet } from "@/lib/search-context";

/**
 * Related requests use the stable projection from
 * docs/engineering/RELATED_REQUESTS_CONTRACT_2026-10-27.md.
 * The client never adds access: every row comes from the server ACL.
 */
type RelatedItem = {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  state: string | null;
  isDirect: boolean;
  url: string;
};

type RelatedProjection = {
  taskId: string;
  version: number;
  canManage: boolean;
  items: RelatedItem[];
  limited: boolean;
};

type RelatedIntent = {
  operationId: string;
  expectedVersion: number;
  relatedTaskId: string;
  kind: "add" | "remove";
};

type SearchCandidate = {
  phaseLabel?: string | null;
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  state: string | null;
  /** Brief human text; the typed request block itself is never repeated. */
  description: string;
  /** Actual people only: canonical author/executor or legacy creator/assignees. */
  people: string[];
  /** Built from validated local ids; null when a safe card path cannot be formed. */
  url: string | null;
};

type Props = {
  taskId: string;
  version: number;
  actorId: string;
  onChanged?: () => void | Promise<void>;
};

type ParsedCardInput =
  | { kind: "search" }
  | { kind: "invalid"; message: string }
  | { kind: "link"; projectId: string; taskId: string };

const STATE_LABELS: Record<string, string> = {
  DRAFT: "черновик",
  SUBMITTED: "новое обращение",
  IN_PROGRESS: "в работе",
  NEEDS_INFO: "ждём ответа автора",
  COMPLETED: "решено",
  CLOSED: "закрыто",
  CANCELLED: "отменено",
  TODO: "к выполнению",
  IN_REVIEW: "на проверке",
  DONE: "выполнено",
};

const UNKNOWN_STATE = "состояние не указано";
const RELATED_POLL_INTERVAL_MS = 15_000;

const SEARCH_PEOPLE_LIMIT = 4;
const SEARCH_NAME_LIMIT = 120;
const LINK_HOSTS = new Set(["localhost", "127.0.0.1", "taskboard.lenremontn8n.ru"]);
const CARD_PATH = /^\/projects\/([^/]+)\/tasks\/([^/]+)$/;
const CARD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LINK_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const INVALID_LINK_MESSAGE = "Ссылка должна вести на карточку этого приложения: /projects/…/tasks/…. Внешние ссылки не используются.";
const SELF_LINK_MESSAGE = "Нельзя связать обращение с самим собой. Укажите другое доступное обращение.";
const TEXT_SEARCH_ERROR = "Не удалось выполнить поиск доступных обращений. Проверьте подключение и попробуйте ещё раз.";
const LINK_LOOKUP_ERROR = "Не удалось проверить карточку по ссылке. Проверьте подключение и повторите поиск.";
const LINK_UNAVAILABLE_ERROR = "Карточка по ссылке недоступна. Проверьте, что обращение доступно вам, или найдите его по теме.";
const LINK_MISMATCH_ERROR = "Не удалось проверить карточку по ссылке. Найдите доступное обращение по теме или имени.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Only canonical same-app card paths are accepted. A supplied URL is never
 * fetched: the task id is read from the path and checked through the internal
 * details route, which applies the common server ACL.
 */
function parseCardInput(value: string, currentTaskId: string): ParsedCardInput {
  const text = value.trim();
  const looksLikeLink = LINK_SCHEME.test(text) || text.startsWith("/") || text.includes("/projects/");
  if (!looksLikeLink) return { kind: "search" };
  const invalid: ParsedCardInput = { kind: "invalid", message: INVALID_LINK_MESSAGE };
  if (text.startsWith("//") || text.includes("\\") || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(text)) return invalid;

  let url: URL;
  try {
    const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
    url = new URL(text, base);
  } catch {
    return invalid;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return invalid;
  if (url.username || url.password) return invalid;
  if (url.search || url.hash) return invalid;

  const currentHost = typeof window !== "undefined" ? window.location.hostname.toLowerCase() : "";
  const host = url.hostname.toLowerCase();
  if (host !== currentHost && !LINK_HOSTS.has(host)) return invalid;

  const match = CARD_PATH.exec(url.pathname);
  if (!match) return invalid;
  let projectId: string;
  let taskId: string;
  try {
    projectId = decodeURIComponent(match[1]);
    taskId = decodeURIComponent(match[2]);
  } catch {
    return invalid;
  }
  if (!CARD_ID.test(projectId) || !CARD_ID.test(taskId)) return invalid;
  if (taskId === currentTaskId) return { kind: "invalid", message: SELF_LINK_MESSAGE };
  return { kind: "link", projectId, taskId };
}

function safeSameAppUrl(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("/")
    && !value.startsWith("//")
    && !/[\\\u0000-\u0020]/.test(value);
}

function stateLabel(state: string | null): string {
  return state && STATE_LABELS[state] ? STATE_LABELS[state] : UNKNOWN_STATE;
}

/** Reject the whole projection instead of showing a partial or untrusted view. */
function parseProjection(raw: unknown, expectedTaskId: string): RelatedProjection | null {
  if (!isRecord(raw)) return null;
  if (raw.taskId !== expectedTaskId) return null;
  if (!Number.isInteger(raw.version) || (raw.version as number) < 0) return null;
  if (typeof raw.canManage !== "boolean" || typeof raw.limited !== "boolean") return null;
  if (!Array.isArray(raw.items) || raw.items.length > 500) return null;

  const seen = new Set<string>();
  const items: RelatedItem[] = [];
  for (const entry of raw.items) {
    if (!isRecord(entry)) return null;
    const { id, title, projectId, projectName, state, isDirect, url } = entry;
    if (typeof id !== "string" || !id || id === expectedTaskId || seen.has(id)) return null;
    if (typeof title !== "string" || !title.trim()) return null;
    if (typeof projectId !== "string" || !projectId) return null;
    if (typeof projectName !== "string") return null;
    if (state !== null && typeof state !== "string") return null;
    if (typeof isDirect !== "boolean") return null;
    if (!safeSameAppUrl(url)) return null;
    seen.add(id);
    items.push({
      id,
      title: title.trim(),
      projectId,
      projectName,
      state,
      isDirect,
      url,
    });
  }

  return {
    taskId: expectedTaskId,
    version: raw.version as number,
    canManage: raw.canManage,
    items,
    limited: raw.limited,
  };
}

/** Build the canonical card path locally; never trust a URL supplied by a list row. */
function searchCardUrl(projectId: unknown, taskId: unknown): string | null {
  if (typeof projectId !== "string" || typeof taskId !== "string") return null;
  if (!CARD_ID.test(projectId) || !CARD_ID.test(taskId)) return null;
  return `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
}

function pushSearchName(names: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const name = value.trim().slice(0, SEARCH_NAME_LIMIT);
  if (!name) return;
  const key = name.toLocaleLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  names.push(name);
}

/**
 * Actual people of the available card. A canonical request shows only its
 * author/executor; stale legacy creator/assignees must not reappear as extra
 * people after migration.
 */
function searchPeople(entry: Record<string, unknown>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const request = isRecord(entry.request) ? entry.request : null;
  if (request) {
    const author = isRecord(request.author) ? request.author : null;
    const executor = isRecord(request.executor) ? request.executor : null;
    pushSearchName(names, seen, author?.name);
    pushSearchName(names, seen, executor?.name);
    return names.slice(0, SEARCH_PEOPLE_LIMIT);
  }

  const creator = isRecord(entry.createdBy) ? entry.createdBy : null;
  pushSearchName(names, seen, creator?.name);
  if (Array.isArray(entry.assignees)) {
    for (const assignee of entry.assignees) {
      const user = isRecord(assignee) && isRecord(assignee.user) ? assignee.user : null;
      pushSearchName(names, seen, user?.name);
      if (names.length >= SEARCH_PEOPLE_LIMIT) break;
    }
  }
  return names.slice(0, SEARCH_PEOPLE_LIMIT);
}

/** Short readable preview from the existing description, without the typed block. */
function searchDescription(value: unknown): string { return typeof value === "string" ? readableSearchDescription(value) : ""; }

function parseSearchCandidate(
  raw: unknown,
  currentTaskId: string,
): SearchCandidate | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id || raw.id === currentTaskId) return null;
  if (typeof raw.title !== "string" || !raw.title.trim()) return null;
  const project = isRecord(raw.project) ? raw.project : null;
  const request = isRecord(raw.request) ? raw.request : null;
  const projectId = typeof raw.projectId === "string" ? raw.projectId : "";
  const projectName = typeof project?.name === "string" ? project.name : "";
  const state = typeof request?.state === "string"
    ? request.state
    : typeof raw.status === "string" ? raw.status : null;
  return {
    id: raw.id,
    title: raw.title.trim(),
    projectId,
    projectName,
    state,
    phaseLabel: state && (isBeznalProject(projectName)||isClaimProject(projectName)) ? getRequestBoardPhase({request:{state,beznalPhase:typeof request?.beznalPhase==="string"?request.beznalPhase:null},attachments:Array.isArray(raw.attachments)?raw.attachments:[]},isBeznalProject(projectName),isClaimProject(projectName)).label : null,
    description: searchDescription(raw.description),
    people: searchPeople(raw),
    url: searchCardUrl(projectId, raw.id),
  };
}

function parseSearchResults(raw: unknown, currentTaskId: string): SearchCandidate[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const list: SearchCandidate[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const candidate = parseSearchCandidate(entry, currentTaskId);
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    list.push(candidate);
    if (list.length >= 8) break;
  }
  return list;
}

/** One details row is a valid lookup only when it is the exact card in the link. */
function parseLookupCandidate(
  raw: unknown,
  expectedProjectId: string,
  expectedTaskId: string,
): SearchCandidate | null {
  if (!isRecord(raw)) return null;
  if (raw.id !== expectedTaskId || raw.projectId !== expectedProjectId) return null;
  if (typeof raw.title !== "string" || !raw.title.trim()) return null;
  const project = isRecord(raw.project) ? raw.project : null;
  const request = isRecord(raw.request) ? raw.request : null;
  const projectName = typeof project?.name === "string" ? project.name : "";
  const state = typeof request?.state === "string"
    ? request.state
    : typeof raw.status === "string" ? raw.status : null;
  return {
    id: expectedTaskId,
    title: raw.title.trim(),
    projectId: expectedProjectId,
    projectName,
    state,
    phaseLabel: state && (isBeznalProject(projectName)||isClaimProject(projectName)) ? getRequestBoardPhase({request:{state,beznalPhase:typeof request?.beznalPhase==="string"?request.beznalPhase:null},attachments:Array.isArray(raw.attachments)?raw.attachments:[]},isBeznalProject(projectName),isClaimProject(projectName)).label : null,
    description: searchDescription(raw.description),
    people: searchPeople(raw),
    url: searchCardUrl(expectedProjectId, expectedTaskId),
  };
}

function statusOf(error: unknown): number | null {
  if (!isRecord(error) && !(error instanceof Error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function mutationMessage(status: number | null): { text: string; retryable: boolean } {
  if (status === 409) return {
    text: "Карточка уже изменилась. Список связей обновлён. Проверьте выбранное обращение и повторите действие.",
    retryable: false,
  };
  if (status === 403 || status === 404) return {
    text: "Не удалось изменить связи: возможно, изменились права или доступ к карточке. Список обновлён — проверьте доступные обращения.",
    retryable: false,
  };
  if (status === 429) return {
    text: "Слишком много запросов. Подождите немного и повторите действие.",
    retryable: true,
  };
  if (status === 400 || status === 422) return {
    text: "Сервер не принял это изменение. Проверьте, что выбранное обращение доступно, и повторите действие.",
    retryable: false,
  };
  return {
    text: "Сервер не подтвердил изменение связи. Повторите ту же команду, чтобы проверить результат.",
    retryable: true,
  };
}

function ItemCard({ item, canManage, busy, confirmRemove, onAskRemove, onCancelRemove, onRemove }: {
  item: RelatedItem;
  canManage: boolean;
  busy: boolean;
  confirmRemove: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Link
            href={item.url}
            className="inline-flex min-h-11 items-center gap-2 text-base font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
          >
            <Link2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            {item.title}
          </Link>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {item.projectName ? `Отдел: ${item.projectName}. ` : ""}Состояние: {stateLabel(item.state)}
          </p>
          <p className="text-sm font-medium">
            {item.isDirect ? "Прямая связь" : "Через другое обращение"}
          </p>
        </div>
        {canManage && item.isDirect && !confirmRemove ? (
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 whitespace-normal text-left"
            disabled={busy}
            onClick={onAskRemove}
          >
            Убрать прямую связь
          </Button>
        ) : null}
      </div>

      {canManage && item.isDirect && confirmRemove ? (
        <div
          className="mt-3 space-y-3 rounded-lg border bg-muted/30 p-3"
          role="group"
          aria-label={`Подтверждение удаления связи с обращением «${item.title}»`}
        >
          <p className="text-sm">
            Убрать только эту прямую связь? Оба обращения, их файлы и переписка останутся на месте.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              className="h-auto min-h-11 whitespace-normal text-left"
              disabled={busy}
              onClick={onRemove}
            >
              Убрать связь
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 whitespace-normal text-left"
              disabled={busy}
              onClick={onCancelRemove}
            >
              Оставить связь
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function RelatedPanel({ taskId, version, actorId, onChanged }: Props) {
  const baseId = useId();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["task-related", actorId, taskId] as const, [actorId, taskId]);
  const parentVersion = useRef(version);
  // Both the poll and a command read this ref synchronously. The observer also
  // re-evaluates the interval after every render, so a finished command resumes
  // polling without a background spinner replacing already confirmed rows.
  const mutationRunning = useRef(false);

  const projectionQuery = useQuery({
    queryKey,
    enabled: Boolean(actorId),
    queryFn: async ({ signal }) => {
      const raw = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/related`, {
        method: "GET",
        cache: "no-store",
        signal,
      });
      const projection = parseProjection(raw, taskId);
      if (!projection) throw new Error("INVALID_RELATED_PROJECTION");
      return projection;
    },
    retry: false,
    throwOnError: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: () => (mutationRunning.current ? false : RELATED_POLL_INTERVAL_MS),
  });

  const alive = useRef(false);
  const mutationIntent = useRef<RelatedIntent | null>(null);
  const searchEpoch = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  const latestVersion = useRef<number | null>(null);
  const latestProjection = useRef<RelatedProjection | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchState, setSearchState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRetryable, setSearchRetryable] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchCandidate[]>([]);
  const [resultQuery,setResultQuery] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<{ text: string; retryable: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);

  useEffect(() => {
    if (parentVersion.current === version || mutationBusy) return;
    parentVersion.current = version;
    if (latestProjection.current?.version !== version) {
      void queryClient.invalidateQueries({ queryKey, exact: true });
    }
  }, [mutationBusy, queryClient, queryKey, version]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      searchEpoch.current += 1;
      searchController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const data = projectionQuery.data;
    if (!data) return;
    latestProjection.current = data;
    latestVersion.current = data.version;
  }, [projectionQuery.data]);

  useEffect(() => {
    if (!projectionQuery.isError) return;
    void queryClient.cancelQueries({ queryKey, exact: true });
  }, [projectionQuery.isError, queryClient, queryKey]);

  const refresh = useCallback(async () => {
    try {
      await projectionQuery.refetch();
    } catch {
      /* A refresh cannot undo a committed change. */
    }
  }, [projectionQuery]);

  const runSearch = useCallback(async () => {
    const query = searchText.trim();
    const parsed = parseCardInput(query, taskId);

    const epoch = ++searchEpoch.current;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearchResults([]);
    setSelectedId(null);
    setSearchError(null);
    setSearchRetryable(false);

    if (parsed.kind === "invalid") {
      setSearchState("error");
      setSearchError(parsed.message);
      return;
    }
    if (parsed.kind === "search" && query.length < 2) {
      setSearchState("error");
      setSearchError("Введите не менее двух символов, чтобы найти доступное обращение.");
      return;
    }

    setSearchState("loading");
    try {
      if (parsed.kind === "link") {
        // Only the parsed task id goes to the internal ACL-checked reader. The
        // pasted URL is never fetched and never becomes a navigation target.
        const raw = await apiFetch<unknown>(
          `/api/tasks/${encodeURIComponent(parsed.taskId)}?view=details`,
          { method: "GET", cache: "no-store", signal: controller.signal },
        );
        if (!alive.current || epoch !== searchEpoch.current) return;
        const candidate = parseLookupCandidate(raw, parsed.projectId, parsed.taskId);
        if (!candidate) {
          setSearchState("error");
          setSearchError(LINK_MISMATCH_ERROR);
          return;
        }
        setResultQuery("");
        setSearchResults([candidate]);
        setSearchState("ready");
        return;
      }

      const raw = await apiFetch<unknown>(
        `/api/tasks?search=${encodeURIComponent(query)}&limit=8`,
        { method: "GET", cache: "no-store", signal: controller.signal },
      );
      if (!alive.current || epoch !== searchEpoch.current) return;
      const results = parseSearchResults(raw, taskId);
      if (!results) {
        setSearchState("error");
        setSearchError(TEXT_SEARCH_ERROR);
        setSearchRetryable(true);
        return;
      }
      setResultQuery(query);
      setSearchResults(results);
      setSearchState("ready");
    } catch (error) {
      if (!alive.current || epoch !== searchEpoch.current) return;
      const status = statusOf(error);
      setSearchState("error");
      if (parsed.kind === "link") {
        setSearchError(status === 403 || status === 404 ? LINK_UNAVAILABLE_ERROR : LINK_LOOKUP_ERROR);
        setSearchRetryable(true);
      } else {
        setSearchError(TEXT_SEARCH_ERROR);
        setSearchRetryable(true);
      }
    }
  }, [searchText, taskId]);

  const mutate = useCallback(async (intent: RelatedIntent) => {
    if (mutationRunning.current) return;
    mutationRunning.current = true;
    setMutationBusy(true);
    setMutationError(null);
    setNotice(null);
    setUncertain(false);
    try {
      // Abort and await an in-flight poll before sending the command. Otherwise
      // an older GET could resolve after the ACK and replace the committed rows.
      await queryClient.cancelQueries({ queryKey, exact: true });
      const raw = await apiFetch<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/related`, {
        method: intent.kind === "add" ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          operationId: intent.operationId,
          expectedVersion: intent.expectedVersion,
          relatedTaskId: intent.relatedTaskId,
        }),
      });
      const projection = parseProjection(raw, taskId);
      if (!projection) throw new Error("UNCONFIRMED_RELATED_MUTATION");
      // A committed response for a closed card/account must not refresh the
      // currently open parent or replace its local selection.
      if (!alive.current) return;

      latestProjection.current = projection;
      latestVersion.current = projection.version;
      queryClient.setQueryData(queryKey, projection);
      // The committed server result is final. A parent version refresh may be
      // slow or fail without turning success into an uncertain command.
      try {
        void Promise.resolve(onChanged?.()).catch(() => undefined);
      } catch { /* A parent refresh cannot undo a committed change. */ }
      if (!alive.current) return;
      mutationIntent.current = null;
      setConfirmRemoveId(null);
      setSelectedId(null);
      setUncertain(false);
      setNotice(intent.kind === "add"
        ? "Связь добавлена. Обращения и их переписка не изменились."
        : "Прямая связь убрана. Оба обращения и их переписка остались на месте.");
    } catch (error) {
      if (!alive.current) return;
      const status = statusOf(error);
      const message = mutationMessage(status);
      if (status !== null && status >= 400 && status < 500) {
        mutationIntent.current = null;
        setUncertain(false);
        setMutationError(message);
        // Read the fresh version/permissions before the user can start a new
        // command; the selected target itself is deliberately preserved.
        if (status === 409 || status === 403 || status === 404) await refresh();
      } else {
        // A timeout, network loss or malformed ack: keep the exact intent so a
        // retry cannot silently create a different relationship.
        mutationIntent.current = intent;
        setUncertain(true);
        setMutationError(message);
      }
    } finally {
      mutationRunning.current = false;
      if (alive.current) setMutationBusy(false);
    }
  }, [onChanged, queryClient, queryKey, refresh, taskId]);

  const startMutation = (kind: "add" | "remove", relatedTaskId: string) => {
    if (!relatedTaskId || mutationRunning.current) return;
    const expectedVersion = latestVersion.current ?? projectionQuery.data?.version ?? version;
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      setMutationError({
        text: "Не удалось определить текущую версию карточки. Обновите список связей и повторите действие.",
        retryable: false,
      });
      return;
    }
    const existing = mutationIntent.current;
    const intent = existing
      && existing.kind === kind
      && existing.relatedTaskId === relatedTaskId
      && existing.expectedVersion === expectedVersion
      ? existing
      : {
        operationId: crypto.randomUUID(),
        expectedVersion,
        relatedTaskId,
        kind,
      };
    mutationIntent.current = intent;
    void mutate(intent);
  };

  const retryMutation = () => {
    const intent = mutationIntent.current;
    if (!intent) return;
    void mutate(intent);
  };

  // A cached projection is never shown before this mount has re-read it, so a
  // task switch or account switch cannot flash the previous card's neighbours.
  // Background refreshes keep the current rows and the user's selection.
  const hasData = Boolean(projectionQuery.data);
  const loading = hasData
    ? !projectionQuery.isFetchedAfterMount && projectionQuery.isFetching
    : !projectionQuery.isError;
  const readStatus = statusOf(projectionQuery.error);
  const failed = projectionQuery.isError && !loading &&
    (readStatus === 403 || readStatus === 404 || !(hasData && projectionQuery.isFetchedAfterMount));
  const projection = !loading && !failed ? projectionQuery.data : undefined;

  const directItems = projection?.items.filter(item => item.isDirect) ?? [];
  const indirectItems = projection?.items.filter(item => !item.isDirect) ?? [];
  const relatedIds = new Set(projection?.items.map(item => item.id) ?? []);
  const canManage = Boolean(projection?.canManage);
  const busy = mutationBusy;
  const headingId = `${baseId}-related-heading`;
  const hintId = `${baseId}-related-hint`;
  const searchLabelId = `${baseId}-related-search-label`;
  const resultsLegendId = `${baseId}-related-results-legend`;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={loading || busy}
      className="rounded-xl border bg-background shadow-sm"
    >
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h3 id={headingId} className="min-w-0 flex-1 text-sm font-medium">Связанные обращения</h3>
          {projection ? (
            <span className="rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums" aria-label={`Доступных связанных обращений: ${projection.items.length}`}>
              {projection.limited ? `Показано: ${projection.items.length}` : projection.items.length}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{failed ? "Не удалось загрузить" : "Загрузка…"}</span>
          )}
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="space-y-4 border-t p-4">
        <p id={hintId} className="text-sm text-muted-foreground">
          Связь помогает найти обращения по той же теме. Она не назначает исполнителя, не меняет отдел,
          состояние, срок или получателей и не открывает доступ.
        </p>

      {loading ? (
        <p role="status" className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Загружаем связанные обращения…
        </p>
      ) : failed ? (
        <div className="space-y-3" role="alert">
          <p>
            Не удалось загрузить связанные обращения. Возможно, карточка стала недоступна или у вас нет
            доступа к ней.
          </p>
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 whitespace-normal text-left"
            onClick={() => void projectionQuery.refetch()}
          >
            Повторить загрузку связанных обращений
          </Button>
        </div>
      ) : projection ? (
        <>
          {projection.limited ? (
            <p className="rounded-lg border bg-muted/30 p-3 text-sm">
              Список ограничен, поэтому здесь могут быть показаны не все связанные обращения.
            </p>
          ) : null}

          {!canManage ? (
            <p className="rounded-lg border bg-muted/30 p-3 text-sm">
              Связи могут менять автор обращения, текущий исполнитель и руководитель с правом изменения
              карточки. Наблюдение или чтение такого права не дают.
            </p>
          ) : null}

          {projection.items.length === 0 ? (
            <p className="text-muted-foreground">
              Связанных обращений пока нет.
              {canManage ? " Найдите доступное обращение ниже и подтвердите связь." : ""}
            </p>
          ) : (
            <div className="space-y-4">
              {directItems.length > 0 ? (
                <div className="space-y-2">
                  <h4 className="font-medium">Прямые связи</h4>
                  <p className="text-sm text-muted-foreground">
                    Эти обращения связаны с текущим напрямую. Прямую связь можно убрать здесь.
                  </p>
                  <ul className="space-y-3">
                    {directItems.map(item => (
                      <ItemCard
                        key={item.id}
                        item={item}
                        canManage={canManage}
                        busy={busy}
                        confirmRemove={confirmRemoveId === item.id}
                        onAskRemove={() => { setMutationError(null); setConfirmRemoveId(item.id); }}
                        onCancelRemove={() => setConfirmRemoveId(null)}
                        onRemove={() => startMutation("remove", item.id)}
                      />
                    ))}
                  </ul>
                </div>
              ) : null}

              {indirectItems.length > 0 ? (
                <div className="space-y-2">
                  <h4 className="font-medium">Через другое обращение</h4>
                  <p className="text-sm text-muted-foreground">
                    Эти обращения связаны с текущим через промежуточную карточку. Чтобы изменить такую
                    связь, откройте промежуточное обращение.
                  </p>
                  <ul className="space-y-3">
                    {indirectItems.map(item => (
                      <ItemCard
                        key={item.id}
                        item={item}
                        canManage={canManage}
                        busy={busy}
                        confirmRemove={false}
                        onAskRemove={() => undefined}
                        onCancelRemove={() => undefined}
                        onRemove={() => undefined}
                      />
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}

          {notice ? <p role="status" className="text-sm">{notice}</p> : null}

          {mutationError ? (
            <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 p-3 text-sm">
              <p>{mutationError.text}</p>
              {mutationError.retryable && uncertain ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-11 whitespace-normal text-left"
                  disabled={busy}
                  onClick={retryMutation}
                >
                  Повторить ту же команду
                </Button>
              ) : null}
            </div>
          ) : null}

          {canManage ? (
            <div className="space-y-3 border-t pt-4">
              <h4 className="font-medium">Добавить связь</h4>
              <p className="text-sm text-muted-foreground">
                Найдите обращение по словам из темы или описания, имени человека либо вставьте ссылку на него.
              </p>
              <div className="space-y-2 rounded-lg border bg-background/60 p-3 text-sm">
                <p className="font-medium">Что можно искать</p>
                <ul id={`${baseId}-related-search-fields`} className="list-disc space-y-1 pl-5 text-muted-foreground">
                  <li><strong className="text-foreground">Тему и описание</strong> — включая телефон, адрес, ФИО или номер заказа, если они указаны в описании.</li>
                  <li><strong className="text-foreground">Людей</strong> — имена автора обращения и исполнителя.</li>
                  <li><strong className="text-foreground">Другие данные карточки</strong> — направление, метки и идентификатор обращения.</li>
                </ul>
              </div>
              <form
                className="flex flex-col gap-2 sm:flex-row sm:items-end"
                onSubmit={(event) => { event.preventDefault(); void runSearch(); }}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <label id={searchLabelId} htmlFor={`${baseId}-related-search`} className="text-sm font-medium">
                    Найти доступное обращение
                  </label>
                  <Input
                    id={`${baseId}-related-search`}
                    type="search"
                    value={searchText}
                    onChange={(event) => {
                      setSearchText(event.target.value);
                      if (searchState === "error") {
                        setSearchState("idle");
                        setSearchError(null);
                        setSearchRetryable(false);
                      }
                    }}
                    placeholder="Например: принтер Смирнов, номер заказа или ссылка"
                    aria-describedby={`${baseId}-related-search-fields ${baseId}-related-search-hint`}
                    disabled={busy}
                  />
                  <p id={`${baseId}-related-search-hint`} className="text-sm text-muted-foreground">
                    Не менее двух символов. Можно вводить несколько слов в любом порядке.
                    В результатах будут только доступные вам обращения.
                  </p>
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  className="h-auto min-h-11 whitespace-normal text-left"
                  disabled={busy || searchState === "loading"}
                >
                  <Search className="h-4 w-4" aria-hidden="true" />
                  Найти обращения
                </Button>
              </form>
              <p className="text-sm text-muted-foreground">
                Откройте найденную карточку в новой вкладке и проверьте её тему, описание, отдел и людей.
                Связь появится только после выбора карточки и нажатия «Связать выбранное обращение».
              </p>

              {searchState === "loading" ? (
                <p role="status" className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Ищем доступные обращения…
                </p>
              ) : null}

              {searchState === "error" && searchError ? (
                <div role="alert" className="space-y-2">
                  <p>{searchError}</p>
                  {searchRetryable ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-11 whitespace-normal text-left"
                      onClick={() => void runSearch()}
                    >
                      Повторить поиск
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {searchState === "ready" ? (
                searchResults.length === 0 ? (
                  <p className="text-muted-foreground">
                    Доступных обращений не найдено. Измените запрос или проверьте, что нужная карточка
                    доступна вам.
                  </p>
                ) : (
                  <fieldset className="space-y-2">
                    <legend id={resultsLegendId} className="text-sm font-medium">
                      Доступные обращения
                    </legend>
                    <ul className="max-h-80 space-y-2 overflow-y-auto" aria-labelledby={resultsLegendId}>
                      {searchResults.map(candidate => {
                        const already = relatedIds.has(candidate.id);
                        return (
                          <li key={candidate.id}>
                            <div
                              className={`flex min-h-12 flex-wrap items-start gap-3 rounded-lg border bg-card p-3 ${already ? "opacity-70" : ""}`}
                            >
                              <label className={`flex min-w-0 flex-1 items-start gap-3 ${already ? "" : "cursor-pointer"}`}>
                                <input
                                  type="radio"
                                  name={`${baseId}-related-candidate`}
                                  className="mt-1 h-4 w-4"
                                  value={candidate.id}
                                  checked={selectedId === candidate.id}
                                  disabled={already || busy}
                                  onChange={() => setSelectedId(candidate.id)}
                                />
                                <span className="min-w-0 space-y-1">
                                  <span className="block font-medium [overflow-wrap:anywhere]"><SearchHighlight text={candidate.title} query={resultQuery}/></span>
                                  <span className="block text-sm text-muted-foreground [overflow-wrap:anywhere]">
                                    {candidate.projectName ? <><SearchHighlight text={`Отдел: ${candidate.projectName}. `} query={resultQuery}/></> : ""}
                                    Состояние: {candidate.phaseLabel??stateLabel(candidate.state)}
                                  </span>
                                  {candidate.description ? (
                                    <span className="block text-sm text-muted-foreground [overflow-wrap:anywhere]">
                                      Описание: <SearchHighlight text={searchSnippet(candidate.description,resultQuery)} query={resultQuery}/>
                                    </span>
                                  ) : null}
                                  {candidate.people.length > 0 ? (
                                    <span className="block text-sm text-muted-foreground [overflow-wrap:anywhere]">
                                      Люди: <SearchHighlight text={candidate.people.join(", ")} query={resultQuery}/>
                                    </span>
                                  ) : null}
                                  {already ? <span className="block text-sm">Уже связана с этим обращением</span> : null}
                                </span>
                              </label>
                              {candidate.url ? (
                                <Link
                                  href={candidate.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex min-h-11 shrink-0 items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  aria-label={`Открыть «${candidate.title}» в новой вкладке`}
                                >
                                  <ExternalLink className="h-4 w-4 shrink-0" aria-hidden="true" />
                                  Открыть в новой вкладке
                                </Link>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                )
              ) : null}

              {searchState === "ready" && searchResults.length > 0 ? (
                <Button
                  type="button"
                  className="h-auto min-h-11 whitespace-normal text-left"
                  disabled={!selectedId || busy}
                  onClick={() => { if (selectedId) startMutation("add", selectedId); }}
                >
                  Связать выбранное обращение
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
        </div>
      </details>
    </section>
  );
}

/** Actor identity gates the read; a new actor/task remounts every local selection. */
export function TaskRelatedRequests({ taskId, version, actorId, onChanged }: Props) {
  if (!actorId) return null;
  return (
    <RelatedPanel
      key={`${taskId}\u0000${actorId}`}
      taskId={taskId}
      version={version}
      actorId={actorId}
      onChanged={onChanged}
    />
  );
}
