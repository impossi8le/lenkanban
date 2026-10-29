"use client";
import {useMemo,useState} from "react";
import {Button} from "@/components/ui/button";
import {Sheet,SheetContent,SheetDescription,SheetHeader,SheetTitle,SheetTrigger} from "@/components/ui/sheet";
import {decodeRequestDescription} from "@/lib/request-presentation";

/** Text only: never render stored rich text as executable HTML. */
export function beznalDescriptionText(value?:string|null):string {
 const body=decodeRequestDescription(value).body;
 const text=body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6])>/gi,"\n").replace(/<[^>]*>/g,"");
 return text.replace(/&nbsp;/gi," ").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&amp;/gi,"&").trim();
}
export function BeznalDemoDescription({title,description}:{title:string;description?:string|null}) {
 const text=useMemo(()=>beznalDescriptionText(description),[description]);
 const [notice,setNotice]=useState("");
 const copy=async()=>{try{await navigator.clipboard.writeText(text);setNotice("Описание скопировано");}catch{setNotice("Не удалось скопировать. Можно выделить текст и скопировать вручную.");}};
 return <Sheet onOpenChange={()=>setNotice("")}><SheetTrigger asChild><Button type="button" variant="ghost" className="min-h-11 px-0 text-primary underline">Описание полностью</Button></SheetTrigger>
  <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
   <SheetHeader><SheetTitle>Описание обращения</SheetTitle><SheetDescription className="break-words">{title}</SheetDescription></SheetHeader>
   <div className="my-6 whitespace-pre-wrap break-words text-base leading-relaxed">{text||"Описание не заполнено"}</div>
   {text&&<Button type="button" variant="outline" className="min-h-12" onClick={()=>void copy()}>Скопировать описание</Button>}
   {notice&&<p role="status" className="mt-4 text-sm">{notice}</p>}
  </SheetContent>
 </Sheet>;
}
