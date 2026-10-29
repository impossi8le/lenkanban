"use client";
import { createContext, useContext, useRef, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { apiPost } from "@/lib/api";
import { Button } from "@/components/ui/button";
export const RequestActionsContext = createContext(false);
export function RequestQuickTake({taskId,projectId,version}:{taskId:string;projectId:string;version:number}) {
  const allowed=useContext(RequestActionsContext), client=useContext(QueryClientContext);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const intent=useRef<{action:"take";operationId:string;expectedVersion:number}|null>(null);
  const locked=useRef(false);
  if(!allowed||!client)return null;
  const take=async()=>{if(locked.current)return;locked.current=true;setBusy(true);setError(null);
    intent.current??={action:"take",operationId:crypto.randomUUID(),expectedVersion:version};
    try{await apiPost(`/api/tasks/${encodeURIComponent(taskId)}`,intent.current);intent.current=null;void client.invalidateQueries({queryKey:["tasks",projectId]});void client.invalidateQueries({queryKey:["task-lifecycle",taskId]});}
    catch(e){const status=(e as {status?:number}).status;setError(status===409?"Обращение изменилось. Обновите список.":"Не удалось подтвердить действие. Повторите запрос.");if(status===409||status===403){intent.current=null;void client.invalidateQueries({queryKey:["tasks",projectId]});}}
    finally{locked.current=false;setBusy(false);}};
  return <div onClick={e=>e.stopPropagation()} className="request-quick-take">
    <Button size="sm" className="min-h-10" disabled={busy} onClick={()=>void take()}>{busy?"Берём в работу…":intent.current?"Повторить запрос":"Взять в работу →"}</Button>
    {error&&<p role="alert" className="mt-1 text-sm text-destructive">{error}</p>}
  </div>;
}
