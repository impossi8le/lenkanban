"use client";
import {useEffect,useId,useRef,useState,type FormEvent,type RefObject} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Textarea} from "@/components/ui/textarea";
import {apiFetch,apiPost} from "@/lib/api";
import {createTaskSchema,type CreateTaskInput} from "@/lib/validators";
import {isClaimProject,isBeznalProject} from "@/lib/request-presentation";
import {getBrowserTelemetryClient} from "@/lib/telemetry/client";
import {useSession} from "next-auth/react";
import {useRouter} from "next/navigation";
import {toast} from "sonner";
import {useRequestDialog} from "./RequestDialogProvider";
import {TaskFormAttachments,attachmentUploadErrorMessage,isDefinitiveUploadRefusal,uploadTaskAttachments} from "./TaskFormAttachments";
import {RequestAudienceField,type RequestAudienceChoice,type RequestRecipient} from "./RequestAudienceField";


interface CreateTaskDialogProps {projectId:string;projectName?:string;canCreate:boolean;open:boolean;onClose:()=>void;returnFocusRef?:RefObject<HTMLButtonElement|null>;}
type CreationIntent={operationId:string;body:CreateTaskInput;taskId?:string;uploaded:boolean;uploadUnconfirmed?:boolean;submit?:{operationId:string;expectedVersion:number;action:"submit"}};
const categories={it:["Программы и CRM","Телефония","Компьютер","Гарнитура и звук","Доступы","Другое"],claim:["Цена","Опоздание","Повторный брак","Грубость","Качество"]};
export function CreateTaskDialog(props:CreateTaskDialogProps){const {data,status}=useSession();if(status==='loading')return null;if(!data?.user?.id)return props.open?<p role="alert">Войдите заново, чтобы отправить обращение.</p>:null;return <RequestCreationForm key={`${data.user.id}:${props.projectId}`} {...props} actorId={data.user.id}/>;}
function RequestCreationForm({projectId,projectName,canCreate,open,onClose,returnFocusRef,actorId}:CreateTaskDialogProps & {actorId:string}){
 const router=useRouter();
 const openRequest=useRequestDialog();
 const client=useQueryClient(),id=useId(),busyRef=useRef(false),mounted=useRef(true),intent=useRef<CreationIntent|null>(null),openRef=useRef(open),generation=useRef(0);
 const [pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),[status,setStatus]=useState<string|null>(null);
 const [title,setTitle]=useState(""),[description,setDescription]=useState(""),[files,setFiles]=useState<File[]>([]);
 const [category,setCategory]=useState(""),[urgent,setUrgent]=useState(false),[order,setOrder]=useState(""),[phone,setPhone]=useState(""),[customer,setCustomer]=useState(""),[want,setWant]=useState("Повторный выезд");
 const [audience,setAudience]=useState<RequestAudienceChoice>({mode:"DEPARTMENT",userIds:[]});
 const recipients=useQuery({queryKey:["request-recipients",actorId,projectId],enabled:open&&canCreate&&audience.mode==='SELECTED',retry:false,staleTime:0,
  queryFn:async({signal})=>{const result=await apiFetch<{recipients:RequestRecipient[]}>(`/api/projects/${encodeURIComponent(projectId)}/request-recipients`,{signal});if(!Array.isArray(result.recipients))throw new Error("Invalid recipient list");return result.recipients;}});
 const audienceReady=audience.mode==='DEPARTMENT'||audience.mode==='SELECTED'&&audience.userIds.length>0&&audience.userIds.length<=20&&!recipients.isFetching&&!recipients.isError&&audience.userIds.every(person=>recipients.data?.some(row=>row.id===person));
 const beznal=isBeznalProject(projectName),claim=!beznal&&isClaimProject(projectName),kind=beznal?"beznal":claim?"claim":"it",frozen=pending||intent.current!==null;
 const filesLocked=pending||Boolean(intent.current&&(!intent.current.taskId||intent.current.uploaded||intent.current.uploadUnconfirmed));
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{openRef.current=open;if(!open)generation.current++;},[open]);
 const submit=async(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();if(!canCreate||busyRef.current)return;
  if(!intent.current&&!audienceReady){setError(audience.mode==='SELECTED'?"Выберите хотя бы одного доступного сотрудника отдела.":"Выберите, кто увидит обращение: весь отдел или конкретные сотрудники.");return;}
  if(!intent.current){const parsed=createTaskSchema.safeParse({projectId,title,description,priority:urgent?"URGENT":"LOW",audience:{mode:audience.mode,userIds:audience.mode==='DEPARTMENT'?[]:audience.userIds},requestDetails:beznal?{kind,category:"Безнал ОП"}:{kind,category:category||categories[claim?"claim":"it"][0],...(claim?{order,phone,client:customer,want}:{})}});
   if(!parsed.success){setError(parsed.error.issues[0]?.message??"Проверьте поля обращения");return;}intent.current={operationId:crypto.randomUUID(),body:parsed.data,uploaded:false};}
  const current=intent.current,epoch=generation.current,isCurrent=()=>mounted.current&&openRef.current&&generation.current===epoch;busyRef.current=true;setPending(true);setError(null);
  const telemetry=getBrowserTelemetryClient(),action=telemetry?.beginAction("task.create"),started=performance.now();
  let phase:"create"|"upload"|"submit"="create";
  try{
   if(!current.taskId){setStatus("Создаём обращение…");const created=await apiPost<{id?:string;taskId?:string}>("/api/tasks",{...current.body,operationId:current.operationId});current.taskId=created.id??created.taskId;if(!current.taskId)throw new Error("Не получен идентификатор обращения. Повторите этот же запрос.");}
   if(!isCurrent())return;
   if(!current.uploaded){if(files.length){phase="upload";setStatus("Прикрепляем файлы…");try{const uploaded=await uploadTaskAttachments(current.taskId,files);if(beznal&&uploaded.length>0&&isCurrent())window.dispatchEvent(new CustomEvent('beznal:attachment-committed',{detail:{taskId:current.taskId}}));}catch(e){if(!isDefinitiveUploadRefusal(e)){current.uploaded=true;current.uploadUnconfirmed=true;}throw e;}}current.uploaded=true;}
   if(!isCurrent())return;
   setStatus("Отправляем получателям…");
   phase="submit";
   const snapshot=await apiFetch<{version:number;marked:boolean;state:string|null}>(`/api/tasks/${encodeURIComponent(current.taskId)}/lifecycle`);
   if(!isCurrent())return;
   if(snapshot.state===null||snapshot.state==='DRAFT'){
    current.submit??={operationId:crypto.randomUUID(),expectedVersion:snapshot.version,action:"submit"};
    try{await apiPost(`/api/tasks/${encodeURIComponent(current.taskId)}`,current.submit);}catch(e){const rejection=e as {status?:number;payload?:{error?:{code?:string}}};if(rejection.status===409&&rejection.payload?.error?.code==='STALE_TASK_VERSION')delete current.submit;throw e;}
   }
   if(action)telemetry?.finishAction(action,{outcome:"success",durationMs:performance.now()-started});
   void client.invalidateQueries({queryKey:["tasks",projectId]});void client.invalidateQueries({queryKey:["project",projectId]});
   if(isCurrent()){const taskId=current.taskId;intent.current=null;setTitle("");setDescription("");setFiles([]);setOrder("");setPhone("");setCustomer("");setCategory("");setUrgent(false);setAudience({mode:"DEPARTMENT",userIds:[]});setStatus(null);toast.success("Обращение отправлено",{description:current.body.audience?.mode==='SELECTED'?"Отправлено выбранным сотрудникам. Открываем ваше обращение.":`Получатель: ${projectName || (claim ? "Претензии клиентов" : "Техподдержка и ИТ")}. Открываем ваше обращение.`});onClose();if(openRequest)openRequest({projectId,taskId},returnFocusRef?.current);else router.push(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,{scroll:false});}
  }catch(e){if(action)telemetry?.finishAction(action,{outcome:"failure",durationMs:performance.now()-started});if(mounted.current){setStatus(null);const code=(e as {payload?:{error?:{code?:string}}}).payload?.error?.code;setError(code==='LIFECYCLE_COLUMNS_REQUIRED'||code==='INVALID_LIFECYCLE_COLUMNS'?"Маршрут отдела не настроен. Сообщите администратору; повтор не создаст копию.":code==='STALE_TASK_VERSION'?"Обращение изменилось. Повторите отправку: будет проверена свежая версия, копия обращения не создастся.":phase==='upload'?attachmentUploadErrorMessage(e,"Не удалось прикрепить файлы. Черновик обращения сохранён"):"Не удалось подтвердить отправку. Повторите запрос — обращение не будет создано повторно.");}}
  finally{busyRef.current=false;if(mounted.current)setPending(false);}
 };
 return <Dialog open={open} onOpenChange={value=>{if(!value&&!pending)onClose();}}><DialogContent className="request-create-dialog max-h-[90dvh] min-w-0 overflow-y-auto sm:max-w-[650px]" onCloseAutoFocus={event=>{if(document.querySelector('[role="dialog"][aria-modal="true"]:not([data-state="closed"])')){event.preventDefault();return;}if(returnFocusRef?.current?.isConnected){event.preventDefault();returnFocusRef.current.focus();}}}>
  <DialogHeader className="request-create-header"><DialogTitle className="request-create-title">{beznal?"Новая заявка в Безнал ОП":claim?"Новая претензия клиента":"Обращение в Техподдержку"}</DialogTitle><DialogDescription>{beznal?"Передайте информацию о счёте или платеже коллегам.":claim?"Передайте информацию, чтобы коллега мог связаться с клиентом.":"Расскажите, что случилось. Вы увидите, кто взял обращение в работу."}</DialogDescription></DialogHeader>
  {!canCreate?<><p role="alert">У вас нет права создавать обращения в этом отделе.</p><Button onClick={onClose}>Закрыть</Button></>:<form onSubmit={event=>void submit(event)} className="space-y-4" aria-busy={pending}>
   {!beznal&&<div><Label>{claim?"В чём претензия?":"Что случилось?"}</Label><div className="mt-2 flex flex-wrap gap-2">{categories[claim?"claim":"it"].map(c=><button key={c} type="button" disabled={frozen} aria-pressed={(category||categories[claim?"claim":"it"][0])===c} onClick={()=>setCategory(c)} className={`min-h-11 rounded-lg border px-3 text-sm ${(category||categories[claim?"claim":"it"][0])===c?'border-primary bg-accent font-semibold text-accent-foreground':'bg-card'}`}>{c}</button>)}</div></div>}
   {claim&&<div className="grid gap-4 sm:grid-cols-2"><div><Label htmlFor={`${id}-order`}>Номер заказа</Label><Input id={`${id}-order`} value={order} onChange={e=>setOrder(e.target.value)} inputMode="numeric" pattern="[0-9]{1,20}" required disabled={frozen} maxLength={20}/></div><div><Label htmlFor={`${id}-phone`}>Телефон клиента</Label><Input id={`${id}-phone`} type="tel" value={phone} onChange={e=>setPhone(e.target.value)} required disabled={frozen} maxLength={100}/></div><div><Label htmlFor={`${id}-client`}>Как зовут клиента (необязательно)</Label><Input id={`${id}-client`} value={customer} onChange={e=>setCustomer(e.target.value)} disabled={frozen} maxLength={200}/></div><div><Label htmlFor={`${id}-want`}>Чего хочет клиент</Label><select id={`${id}-want`} value={want} onChange={e=>setWant(e.target.value)} disabled={frozen} className="min-h-11 w-full rounded-lg border bg-card px-3">{["Повторный выезд","Вернуть деньги","Скидку","Извинения","Поговорить с руководителем","Другое"].map(w=><option key={w}>{w}</option>)}</select></div></div>}
   <div className="space-y-2"><Label htmlFor={`${id}-title`}>{beznal?"Тема":"Кратко о проблеме"}</Label><Input autoFocus id={`${id}-title`} value={title} onChange={e=>setTitle(e.target.value)} required disabled={frozen} maxLength={200}/></div>
   <div className="space-y-2"><Label htmlFor={`${id}-description`}>{beznal?"Описание (необязательно)":"Подробности (необязательно)"}</Label><Textarea id={`${id}-description`} value={description} onChange={e=>setDescription(e.target.value)} rows={4} maxLength={48000} disabled={frozen} placeholder="Расскажите своими словами, что произошло"/></div>
   <fieldset disabled={frozen}><legend className="text-sm font-medium">Срочность</legend><div className="mt-2 grid grid-cols-2 gap-3">{[false,true].map(value=><label key={String(value)} className="flex min-h-12 items-center gap-2 rounded-lg border p-3 text-sm"><input type="radio" name={`${id}-urgent`} checked={urgent===value} onChange={()=>setUrgent(value)}/>{value?"Срочно":"Не срочно"}</label>)}</div>{claim&&<p className="mt-2 text-sm text-muted-foreground">Выберите «Срочно», если клиент грозит отзывом, жалобой или судом.</p>}</fieldset>
   <TaskFormAttachments id={`${id}-attachments`} files={files} onChange={next=>{setFiles(next);setError(null);}} disabled={filesLocked} busy={pending&&files.length>0} status={status} error={null}/>
   {intent.current?.uploadUnconfirmed&&<p role="note" className="rounded-lg border p-3 text-sm">Обращение сохранено, но загрузка файлов не подтверждена. Проверьте вложения в карточке. Повторно эти файлы не загружаются; можно продолжить без подтверждённых файлов и при необходимости добавить недостающие позже.</p>}
   {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
   {status&&<p role="status" className="text-sm text-muted-foreground">{status}</p>}
   <RequestAudienceField value={audience} onChange={setAudience} recipients={recipients.data??[]} loading={recipients.isFetching||recipients.isPending} error={recipients.isError} onRetry={()=>void recipients.refetch()} disabled={frozen} department={projectName || (claim ? "Претензии клиентов" : "Техподдержка и ИТ")}/>
   <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={onClose}>Вернуться</Button><Button type="submit" className="min-h-11 bg-red-600 text-white hover:bg-red-700" disabled={pending||(!intent.current&&!audienceReady)}>{pending?"Отправляем…":intent.current?.uploadUnconfirmed?"Продолжить без подтверждённых файлов":intent.current?"Повторить отправку":"Отправить обращение"}</Button></DialogFooter>
  </form>}
 </DialogContent></Dialog>;
}
