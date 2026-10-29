"use client";

import { useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import dynamic from "next/dynamic";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { QuickStart, type QuickStartDirections, type QuickStartDirection } from "./QuickStart";
const CreateTaskDialog = dynamic(() => import("@/components/task/CreateTaskDialog").then(module => module.CreateTaskDialog), { ssr: false });

/** The chooser fetches permissions only when opened and shares cached results. */
export function GlobalCreateRequest({ collapsed = false }: { collapsed?: boolean }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<QuickStartDirection | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { data: session } = useSession();
  const directions = useQuery({ queryKey: ["request-directions", session?.user?.id], queryFn: ({ signal }) => apiFetch<QuickStartDirections>("/api/request-directions", { signal }), enabled: open && Boolean(session?.user?.id), staleTime: 30_000, retry: false });
  return <>
    <Button ref={trigger} className="global-create-request min-h-11 w-full bg-red-600 text-white hover:bg-red-700" onClick={() => setOpen(true)} title={collapsed ? "Добавить обращение" : undefined} aria-label="Добавить обращение">
      <Plus className="h-5 w-5 shrink-0" aria-hidden="true" />{!collapsed && <span>Добавить обращение</span>}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="request-direction-chooser max-w-3xl" onCloseAutoFocus={event => { event.preventDefault(); if (!selected) trigger.current?.focus(); }}>
        <DialogHeader><DialogTitle>Куда вам нужно обратиться?</DialogTitle><DialogDescription>Выберите отдел — откроется форма обращения.</DialogDescription></DialogHeader>
        {directions.isPending ? <p role="status">Загрузка направлений…</p> : directions.isError ? <div role="alert"><p>Не удалось загрузить направления.</p><Button variant="outline" onClick={() => void directions.refetch()}>Повторить</Button></div> : <QuickStart directions={directions.data ?? {}} canSetupDirections={false} onDirectionSelect={direction => { setOpen(false); setSelected(direction); }} />}
      </DialogContent>
    </Dialog>
    {selected && <CreateTaskDialog projectId={selected.projectId} projectName={selected.projectName} canCreate open onClose={() => setSelected(null)} returnFocusRef={trigger} />}
  </>;
}
