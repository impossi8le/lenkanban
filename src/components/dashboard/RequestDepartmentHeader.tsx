import type {Ref} from "react";
import {Button} from "@/components/ui/button";

/** The existing department-board heading, shared by both permitted views. */
export function RequestDepartmentHeader({projectName,canCreate,canExecuteRequests,onCreate,createButtonRef}:{
 projectName?:string;canCreate:boolean;canExecuteRequests:boolean;onCreate:()=>void;createButtonRef?:Ref<HTMLButtonElement>;
}) {
 return <div className="mb-3 flex min-w-0 shrink-0 flex-col items-stretch justify-between gap-3 py-2 sm:flex-row sm:items-center">
  <div className="min-w-0 flex-1"><p className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">Запросы в отделы</p><h1 className="[overflow-wrap:anywhere] text-[28px] font-bold leading-tight tracking-tight">{projectName || "Запросы в отдел"}</h1><p className="mt-2 text-muted-foreground">{canExecuteRequests ? "Возьмите новое обращение в работу и помогите сотруднику." : "Ваши обращения: видно, кто помогает и кого ждать."}</p></div>
  {canCreate&&<Button ref={createButtonRef} type="button" data-create-task className="min-h-11 w-full shrink-0 bg-red-600 text-white hover:bg-red-700 sm:w-auto" onClick={onCreate}>Добавить обращение</Button>}
 </div>;
}
