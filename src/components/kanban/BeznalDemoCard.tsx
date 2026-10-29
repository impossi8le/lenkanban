"use client";
import {SearchHighlight,TaskSearchContext} from "@/components/ui/SearchHighlight";
import {useContext,useId,useRef,useState} from "react";
import {useSession} from "next-auth/react";
import {QueryClientContext} from "@tanstack/react-query";
import {TaskCardDates} from "@/components/task/TaskChangeInformation";
import {Button} from "@/components/ui/button";
import {RequestActionsContext} from "@/components/task/RequestQuickTake";
import {ATTACHMENT_ACCEPT,uploadTaskAttachments} from "@/components/task/TaskFormAttachments";
import type {TaskType} from "./Card";
import {BeznalDemoDescription,beznalDescriptionText} from "./BeznalDemoDescription";

export function BeznalDemoCard({task,onOpen,titleButtonRef,highlighted=false,archived=false,searchQuery}:{task:TaskType;onOpen:(opener?:HTMLButtonElement)=>void;titleButtonRef?:(button:HTMLButtonElement|null)=>void;highlighted?:boolean;archived?:boolean;searchQuery?:string}) {
 const allowed=useContext(RequestActionsContext),client=useContext(QueryClientContext),id=useId();
 const {data:session}=useSession();
 const actorId=session?.user?.id;
 const canUploadDirect=Boolean(actorId&&task.request&&(task.request.author?.id===actorId||allowed&&(task.request.executorId===actorId||!task.request.executorId)));
 const file=useRef<HTMLInputElement>(null),locked=useRef(false),titleOpener=useRef<HTMLButtonElement>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 const author=task.request?.author?.name||task.createdBy?.name||"Сотрудник";
 const executor=task.request?task.request.executor?.name||task.assignees?.find(row=>row.user.id===task.request?.executorId)?.user.name:task.assignees?.[0]?.user.name;
 const upload=async(files:File[])=>{
  if(!canUploadDirect||archived||locked.current||!files.length)return;
  locked.current=true;setBusy(true);setError("");
  try{
   const uploaded=await uploadTaskAttachments(task.id,files);
   if(!uploaded.length)throw new Error("UPLOAD_UNCONFIRMED");
   void client?.invalidateQueries({queryKey:["tasks",task.projectId]});
   void client?.invalidateQueries({queryKey:["project",task.projectId]});
   void client?.invalidateQueries({predicate:query=>query.queryKey.includes(task.id)});
   window.dispatchEvent(new CustomEvent("beznal:attachment-committed",{detail:{taskId:task.id,attachmentUrls:uploaded.map(file=>file.url)}}));
  }catch{setError("Не удалось подтвердить загрузку. Откройте карточку и проверьте файлы перед повтором.");}
  finally{locked.current=false;setBusy(false);}
 };
 return <article onClick={event=>{
  if(event.defaultPrevented||event.button!==0)return;
  const target=event.target;
  if(!(target instanceof Element)||target.closest('button,a,input,textarea,select,label,[role="button"],[role="dialog"],[contenteditable="true"]'))return;
  const selection=window.getSelection();
  if(selection&&!selection.isCollapsed)return;
  onOpen(titleOpener.current??undefined);
 }} className={`request-card min-w-0 space-y-4 rounded-xl border bg-card p-4 shadow-sm ${highlighted?"border-green-600 ring-2 ring-green-500 ring-offset-2 ring-offset-background":task.queueArrival?.unseen?"ring-2 ring-primary/40":""}`} data-beznal-task-id={task.id} data-queue-unseen={task.queueArrival?.unseen||undefined} data-beznal-highlighted={highlighted?task.id:undefined}>
  <TaskCardDates task={task}/>
  {task.queueArrival?.unseen&&<p className="text-sm font-semibold text-primary">● Новое для вас</p>}
  <div><p className="text-sm text-muted-foreground">Тема</p><button type="button" ref={button=>{titleOpener.current=button;titleButtonRef?.(button);}} className="min-h-11 w-full break-words text-left text-base font-bold leading-snug text-primary underline-offset-4 hover:underline" onClick={event=>onOpen(event.currentTarget)} aria-label={`Открыть обращение «${task.title}»`}><SearchHighlight text={task.title} query={searchQuery}/></button></div>
  {searchQuery&&<TaskSearchContext task={task} query={searchQuery}/>}
  {!searchQuery&&<div><p className="text-sm text-muted-foreground">Описание</p><p className="line-clamp-3 whitespace-pre-wrap break-words text-base leading-relaxed">{beznalDescriptionText(task.description)||"Не заполнено"}</p><BeznalDemoDescription title={task.title} description={task.description}/></div>}
  <dl className="grid min-w-0 grid-cols-1 gap-3 rounded-lg bg-muted/60 p-3 text-base sm:grid-cols-2"><div><dt className="text-sm text-muted-foreground">Автор</dt><dd className="break-words font-medium">{author}</dd></div><div><dt className="text-sm text-muted-foreground">Исполнитель</dt><dd className="break-words font-medium">{executor||"Не назначен"}</dd></div></dl>
  <div className="flex flex-wrap gap-2">{(allowed||canUploadDirect)&&!archived&&<>{canUploadDirect&&<input ref={file} id={`${id}-file`} aria-label={`Файл счёта для «${task.title}»`} type="file" accept={ATTACHMENT_ACCEPT} multiple hidden disabled={busy} onChange={event=>{const chosen=Array.from(event.currentTarget.files??[]);event.currentTarget.value="";void upload(chosen);}}/>}<Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={event=>{if(canUploadDirect)file.current?.click();else onOpen(event.currentTarget);}}>{busy?"Прикрепляем…":"Прикрепить файл"}</Button></>}</div>
  {allowed&&!archived&&!canUploadDirect&&<p className="text-sm text-muted-foreground">Чтобы добавить файл в обращение коллеги, сначала возьмите его на себя в карточке.</p>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
 </article>;
}
