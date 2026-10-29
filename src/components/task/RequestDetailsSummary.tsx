import {crmOrderUrl,decodeRequestDescription,BANK_KIND_LABELS} from "@/lib/request-presentation";
import type {TaskType} from "@/components/kanban/Card";

/** The compact, readable request identity block shared by both departments. */
export function RequestDetailsSummary({description,task}:{description?:string|null;task?:TaskType}) {
  const {details}=decodeRequestDescription(description);
  if(!task && details?.kind!=='claim' && details?.kind!=='beznal')return null;
  const url=details?.order?crmOrderUrl(details.order):null;
  const executor=task?.assignees?.[0]?.user.name;
  return <section aria-label="Данные обращения" className="grid min-w-0 gap-4 rounded-xl border bg-muted/40 p-4 text-sm sm:grid-cols-2">
    {task&&<>
      <div><p className="mb-1 text-muted-foreground">Кто обратился</p><p className="break-words font-semibold">{task.createdBy?.name||"Сотрудник"}</p></div>
      <div><p className="mb-1 text-muted-foreground">Отдел автора</p><p className="break-words font-semibold">{task.createdBy?.primaryDepartment?.name||"Не указан"}</p></div>
      <div><p className="mb-1 text-muted-foreground">Исполнитель</p><p className={executor?"break-words font-semibold text-green-800 dark:text-green-300":"text-muted-foreground"}>{executor||"Ждёт специалиста"}</p></div>
      <div><p className="mb-1 text-muted-foreground">Категория</p><p className="break-words font-semibold">{details?.category||"Не указана"}</p></div>
    </>}
    {details?.kind==='beznal'&&<>
      {([{label:"Что нужно сделать",value:details.bankKind?BANK_KIND_LABELS[details.bankKind]:undefined},{label:"Организация или плательщик",value:details.company},{label:"Сумма, ₽",value:details.amount},{label:"Дата поступления платежа",value:details.paymentDate?.split("-").reverse().join(".")},{label:"Номер счёта",value:details.invoiceNumber},{label:"Номер заказа",value:details.orderNumber},{label:"Назначение платежа",value:details.paymentPurpose}]).filter(field=>Boolean(field.value)).map(field=><div key={field.label}><p className="mb-1 text-muted-foreground">{field.label}</p><p className="whitespace-pre-wrap break-words font-semibold">{field.value}</p></div>)}
    </>}
    {details?.kind==='claim'&&<>
      {url&&<div><p className="mb-1 text-muted-foreground">Номер заказа</p><a href={url} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary underline">Заказ № {details.order} ↗</a></div>}
      <div><p className="mb-1 text-muted-foreground">Телефон клиента</p><p className="break-words">{details.phone}</p></div>
      <div><p className="mb-1 text-muted-foreground">Клиент</p><p className="break-words">{details.client||'Не указан'}</p></div>
      <div><p className="mb-1 text-muted-foreground">Чего хочет клиент</p><p className="break-words">{details.want||'Не указано'}</p></div>
    </>}
  </section>;
}
