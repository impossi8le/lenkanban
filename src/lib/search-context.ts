import { tokenizeTaskSearch } from "./task-search";
import { BANK_KIND_LABELS, decodeRequestDescription } from "./request-presentation";

export type SearchSegment = { text: string; matched: boolean };
/** Literal Unicode words only; never interpret a query as regex or HTML. */
export function searchSegments(text: string, query?: string | null): SearchSegment[] {
  const tokens = tokenizeTaskSearch(query);
  if (!tokens.length) return [{ text, matched: false }];
  const escaped = tokens.sort((a,b)=>b.length-a.length).map(token=>token.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"));
  const pattern = new RegExp(escaped.join("|"), "giu");
  const parts: SearchSegment[] = []; let offset=0;
  for (const match of text.matchAll(pattern)) {
    const start=match.index!;
    if(start>offset) parts.push({text:text.slice(offset,start),matched:false});
    parts.push({text:match[0],matched:true});offset=start+match[0].length;
  }
  if(offset<text.length)parts.push({text:text.slice(offset),matched:false});
  return parts.length?parts:[{text,matched:false}];
}
export function hasSearchMatch(text: string, query?: string | null): boolean { return searchSegments(text,query).some(part=>part.matched); }
/** Bounded windows around actual matches, including a second distant word. */
export function searchSnippet(text: string, query?: string | null, limit=180): string {
  const clean=text.replace(/\s+/gu," ").trim();
  if(clean.length<=limit)return clean;
  const matches: number[]=[];let offset=0;
  for(const part of searchSegments(clean,query)){if(part.matched)matches.push(offset);offset+=part.text.length;}
  if(!matches.length)return clean.slice(0,limit).trimEnd()+"…";
  const half=Math.floor(limit/2);const first=Math.max(0,matches[0]-Math.floor(half/3));
  const distant=matches.find(index=>index>=first+limit);
  const windows=distant===undefined?[[first,Math.min(clean.length,first+limit)]]:[[first,Math.min(clean.length,first+half)],[Math.max(first+half,distant-Math.floor(half/3)),Math.min(clean.length,distant+half-Math.floor(half/3))]];
  return windows.map(([start,end])=>(start?"…":"")+clean.slice(start,end).trim()+(end<clean.length?"…":"")).join(" ");
}
export function readableSearchDescription(value?: string | null): string {
  const {body}=decodeRequestDescription(value);
  return body.replace(/<\/(?:p|div|li|h[1-6])\s*>|<br\s*\/?>/gi," ").replace(/<[^>]*>/g,"").replace(/\s+/gu," ").trim();
}
export type SearchTask = {
 id:string;title:string;description?:string|null;project?:{name?:string|null}|null;
 createdBy?:{name?:string|null;primaryDepartment?:{name?:string|null}|null}|null;
 request?:{author?:{name?:string|null}|null;executor?:{name?:string|null}|null}|null;
 assignees?:readonly {user:{name?:string|null}}[];
 tags?:readonly {tag:{name:string}}[];
};
export function taskSearchContext(task: SearchTask,query?: string|null): {label:string;text:string}[] {
 const tokens=tokenizeTaskSearch(query);
 if(!tokens.length)return [];
 const {details}=decodeRequestDescription(task.description);
 const fields: [string,string|null|undefined][]=[
  ["Описание",readableSearchDescription(task.description)], ["Направление",task.project?.name],
  ["Автор",task.request?task.request.author?.name:task.createdBy?.name],
  ["Исполнитель",task.request?task.request.executor?.name:task.assignees?.map(row=>row.user.name).filter(Boolean).join(", ")],
  ["Теги",task.tags?.map(row=>row.tag.name).join(", ")],
  ["Организация",details?.company],["Сумма, ₽",details?.amount],["Дата поступления платежа",details?.paymentDate],
  ["Действие по безналу",details?.bankKind ? BANK_KIND_LABELS[details.bankKind] : null],
  ["Номер счёта",details?.invoiceNumber],["Номер заказа",details?.orderNumber],["Заказ",details?.order],
  ["Назначение платежа",details?.paymentPurpose],["Клиент",details?.client],["Телефон",details?.phone],["Пожелание",details?.want],["Категория",details?.category],
  ["ID",tokens.some(token=>Array.from(token).length>=4)?task.id:""]
 ];
 return fields.flatMap(([label,text])=>text&&hasSearchMatch(text,query)?[{label,text:searchSnippet(text,query)}]:[]).slice(0,3);
}

export function matchesTaskSearch(task: SearchTask,query:string):boolean {return tokenizeTaskSearch(query).every(token=>hasSearchMatch(task.title,token)||taskSearchContext(task,token).length>0);}
