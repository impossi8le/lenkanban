import { Fragment } from "react";
import { searchSegments, taskSearchContext, type SearchTask } from "@/lib/search-context";
export function SearchHighlight({text,query}:{text:string;query?:string|null}) {
 return <>{searchSegments(text,query).map((part,index)=>part.matched?<mark key={index} className="rounded-sm bg-yellow-200 text-inherit dark:bg-yellow-700">{part.text}</mark>:<Fragment key={index}>{part.text}</Fragment>)}</>;
}
export function TaskSearchContext({task,query}:{task:SearchTask;query?:string|null}) {
 const fields=taskSearchContext(task,query);
 if(!fields.length)return null;
 return <span className="block space-y-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">{fields.map(field=><span className="block" key={field.label}>{field.label}: <SearchHighlight text={field.text} query={query}/></span>)}</span>;
}
