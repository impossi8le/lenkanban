"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type MouseEvent } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import type { MyTaskSelection } from "@/app/(dashboard)/my-tasks/MyTaskCommandLoader";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { readRequestDetails, requestDetailKey } from "@/lib/request-detail-query";

const LoadingCloseContext = createContext<(() => void) | null>(null);
// A task route owns the only card dialog. A locally opened card must yield to
// the intercepted modal instead of leaving two mounted dialogs side by side.
const TASK_ROUTE = /^\/projects\/[^/]+\/tasks\/[^/]+\/?$/;

function RequestChunkLoading() {
  const close = useContext(LoadingCloseContext);
  return <Dialog open onOpenChange={open => { if (!open) close?.(); }}>
    <DialogContent onCloseAutoFocus={event => event.preventDefault()}>
      <DialogTitle>Загрузка карточки задачи</DialogTitle>
      <DialogDescription role="status">Открываем обращение…</DialogDescription>
    </DialogContent>
  </Dialog>;
}

const importRequestLoader = () => import("@/app/(dashboard)/my-tasks/MyTaskCommandLoader");
const warmRequestLoader = () => { void importRequestLoader().catch(() => undefined); };
const RequestLoader = dynamic(() => importRequestLoader().then(module => module.MyTaskCommandLoader), {
  ssr: false,
  loading: RequestChunkLoading,
});
type RequestTarget = { projectId: string; taskId: string };
type OpenRequest = (target: RequestTarget, opener?: HTMLElement | null) => void;
const Context = createContext<OpenRequest | null>(null);
export const useRequestDialog = () => useContext(Context);

/** Every entry opens the same dialog, with a fresh authorized detail read. */
export function RequestDialogProvider({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const actorId = session?.user?.id;
  const authenticated = status === "authenticated" && Boolean(actorId);
  const client = useQueryClient();
  const [selection, setSelection] = useState<MyTaskSelection | null>(null);
  const sequence = useRef(0);
  const currentIdentity = useRef({ actorId, authenticated });
  currentIdentity.current = { actorId, authenticated };
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => { setSelection(null); opener.current = null; }, [actorId]);
  // Navigating to a task route is destination-owned dialog presentation. Drop
  // the obsolete local selection without routing again: router.back/replace
  // here would cancel the related-link navigation that just completed. The
  // destination's own focus effect then keeps focus in the intercepted card.
  useEffect(() => {
    if (!pathname || !TASK_ROUTE.test(pathname)) return;
    setSelection(null);
    opener.current = null;
  }, [pathname]);
  useEffect(() => {
    if (!selection) return;
    const queryKey = requestDetailKey(selection);
    return () => {
      void client.cancelQueries({ queryKey, exact: true });
      client.removeQueries({ queryKey, exact: true });
    };
  }, [selection, client]);
  const open: OpenRequest = (target, origin) => {
    if (!actorId || !authenticated) return;
    opener.current = origin ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const next = { ...target, actorId, openId: ++sequence.current };
    // Fetch starts on click, in parallel with the editor chunk. Hover only warms
    // public code; it never fetches protected task data or reuses an older open.
    void client.prefetchQuery({ queryKey: requestDetailKey(next),
      queryFn: ({ signal }) => readRequestDetails(next, signal),
      staleTime: Infinity, gcTime: 30_000, retry: false });
    warmRequestLoader();
    setSelection(next);
  };
  const close = () => {
    setSelection(null);
    const origin = opener.current;
    const closedSequence = sequence.current;
    const closedActor = actorId;
    requestAnimationFrame(() => {
      if (currentIdentity.current.actorId !== closedActor || !currentIdentity.current.authenticated || sequence.current !== closedSequence) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused !== document.body && focused !== origin && focused.isConnected) return;
      if (origin?.isConnected && !document.querySelector('[role="dialog"][aria-modal="true"]:not([data-state="closed"])')) origin.focus();
    });
  };
  const invalidate = () => {
    if (!selection) return;
    void client.invalidateQueries({ queryKey: ["tasks", selection.projectId] });
    void client.invalidateQueries({ queryKey: ["my-tasks", actorId] });
  };
  return <Context.Provider value={authenticated ? open : null}>{children}
    {authenticated && selection && selection.actorId === actorId && <LoadingCloseContext.Provider value={close}><RequestLoader key={JSON.stringify(selection)} selection={selection} onClose={close} onDeleted={() => { invalidate(); close(); }} onAuthoritativeRead={invalidate} /></LoadingCloseContext.Provider>}
  </Context.Provider>;
}

/** Normal clicks retain the page behind the dialog; open-in-new-tab keeps its URL. */
export function RequestDialogLink({ projectId, taskId, children, className }: RequestTarget & { children: ReactNode; className?: string }) {
  const open = useRequestDialog();
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!open || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open({ projectId, taskId }, event.currentTarget);
  };
  return <Link prefetch={false} href={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`} onMouseEnter={warmRequestLoader} onFocus={warmRequestLoader} onClick={click} className={className}>{children}</Link>;
}
