"use client";
import {useEffect,useRef,useState} from "react";
import dynamic from "next/dynamic";
import {useQuery} from "@tanstack/react-query";
import {useSession} from "next-auth/react";
import {useRouter} from "next/navigation";
import {apiFetch} from "@/lib/api";
import {TASK_LIST_MAX_LIMIT} from "@/lib/task-list-limits";
import {RequestBoardPresentation,requestDisplayState} from "@/components/kanban/RequestBoardPresentation";
import type {TaskType} from "@/components/kanban/Card";
import {RequestActionsContext} from "@/components/task/RequestQuickTake";
import {useRequestDialog} from "@/components/task/RequestDialogProvider";
import {RequestDepartmentHeader} from "./RequestDepartmentHeader";
import {useRequestQueueUnseenCounts} from "@/hooks/useRequestQueueUnseenCounts";
const CreateTaskDialog=dynamic(()=>import("@/components/task/CreateTaskDialog").then(module=>module.CreateTaskDialog),{ssr:false});
const MAX_BOARD_PAGES=10;

/** Use the existing actor-scoped list. Never publish a partial page as complete. */
async function readApplicantBoard(projectId:string,unseenOnly:boolean,signal:AbortSignal):Promise<TaskType[]> {
 const tasks=new Map<string,TaskType>();
 for(let page=1;page<=MAX_BOARD_PAGES;page++) {
  const rows=await apiFetch<TaskType[]>(`/api/tasks?projectId=${encodeURIComponent(projectId)}&page=${page}&limit=${TASK_LIST_MAX_LIMIT}${unseenOnly?"&unseen=1":""}`,{signal,cache:"no-store"});
  if(!Array.isArray(rows)||rows.length>TASK_LIST_MAX_LIMIT)throw new Error("INVALID_TASK_LIST");
  for(const row of rows) {
   if(!row||typeof row.id!=="string"||row.projectId!==projectId||typeof row.title!=="string")throw new Error("INVALID_TASK_LIST");
   if(requestDisplayState(row)!=="DRAFT")tasks.set(row.id,row);
  }
  if(rows.length<TASK_LIST_MAX_LIMIT)return [...tasks.values()];
 }
 throw new Error("INCOMPLETE_TASK_LIST");
}

/** Same department board; existing server policy scopes every row and command. */
export function ApplicantDirection({projectId,projectName,initiallyOpen=false}:{projectId:string;projectName:string;initiallyOpen?:boolean}) {
 const {data:session,status}=useSession(),router=useRouter(),openRequest=useRequestDialog();
 const actorId=status==="authenticated"?session?.user?.id:undefined;
 // The actor-owned child drops dialogs and presentation filters before a new
 // account can consume the previous actor's transient state.
 return <ApplicantBoard key={`${actorId??"signed-out"}:${projectId}`} projectId={projectId} projectName={projectName} initiallyOpen={initiallyOpen} actorId={actorId} loadingSession={status==="loading"} onOpen={(task,opener)=>openRequest?openRequest({projectId,taskId:task.id},opener):router.push(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}`,{scroll:false})}/>;
}
function ApplicantBoard({projectId,projectName,initiallyOpen,actorId,loadingSession,onOpen}:{projectId:string;projectName:string;initiallyOpen:boolean;actorId?:string;loadingSession:boolean;onOpen:(task:TaskType,opener?:HTMLButtonElement)=>void}) {
 const [open,setOpen]=useState(initiallyOpen),[unseenOnly,setUnseenOnly]=useState(false),trigger=useRef<HTMLButtonElement>(null);
 const queueCounts=useRequestQueueUnseenCounts();
 const tasks=useQuery({queryKey:["tasks",projectId,"applicant",actorId,unseenOnly],enabled:Boolean(actorId),queryFn:({signal})=>readApplicantBoard(projectId,unseenOnly,signal),placeholderData:(previous,query)=>query?.queryKey[1]===projectId&&query.queryKey[3]===actorId?previous:undefined,retry:false,staleTime:0,gcTime:0,refetchOnMount:"always",refetchOnWindowFocus:"always"});
 const refresh=tasks.refetch;
 useEffect(()=>{
  if(!actorId)return;
  const onFocus=()=>{void refresh({cancelRefetch:false});};
  window.addEventListener("focus",onFocus);
  return()=>window.removeEventListener("focus",onFocus);
 },[actorId,refresh]);
 return <RequestActionsContext.Provider value={false}><section className="request-department-page h-full min-h-0 min-w-0 flex flex-col overflow-y-auto">
  <RequestDepartmentHeader projectName={projectName} canCreate={Boolean(actorId)&&!tasks.isError} canExecuteRequests={false} onCreate={()=>setOpen(true)} createButtonRef={trigger}/>
  {loadingSession?<p role="status">Загрузка обращений…</p>:!actorId?<div role="alert" className="space-y-3 rounded-xl border p-4"><p>Войдите заново, чтобы открыть обращения.</p></div>:<>
   {tasks.isPending&&<p role="status">Загрузка обращений…</p>}
   <div className="min-h-0 min-w-0 flex-1" hidden={tasks.isPending}><RequestBoardPresentation projectId={projectId} tasks={tasks.isError?[]:tasks.data??[]} beznal defaultView="board" onOpen={onOpen} unseenOnly={unseenOnly} onUnseenOnlyChange={setUnseenOnly} unseenCount={queueCounts.isLoading||queueCounts.isError?null:queueCounts.byProject[projectId]??0} readError={tasks.isError} readPending={tasks.isFetching} onRetryRead={()=>{void refresh();}}/></div>
  </>}
  {open&&actorId&&!tasks.isError&&<CreateTaskDialog projectId={projectId} projectName={projectName} canCreate open onClose={()=>setOpen(false)} returnFocusRef={trigger}/>}
 </section></RequestActionsContext.Provider>;
}
