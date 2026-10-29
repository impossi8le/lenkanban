import { z } from "zod";

const line = z.string().trim().max(200).refine(value => !/[\r\n]/.test(value));
export const requestDetailsSchema = z.object({
  kind: z.enum(["it", "claim", "beznal"]),
  bankKind: z.enum(["", "invoice", "payment", "other"]).optional(),
  company: line.optional(),
  amount: z.string().trim().max(40).refine(value => !/[\r\n]/.test(value)).optional(),
  paymentDate: z.string().refine(value => value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0,4)) > 0 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value, "Укажите существующую дату").optional(),
  invoiceNumber: line.optional(),
  orderNumber: line.optional(),
  paymentPurpose: z.string().trim().max(1000).optional(),
  category: line,
  order: z.string().regex(/^\d{1,20}$/).optional(),
  phone: line.optional(),
  client: line.optional(),
  want: line.optional(),
}).strict().refine(value => value.kind !== "claim" || Boolean(value.order && value.phone), "Укажите номер заказа и телефон клиента");
export type RequestDetails = z.infer<typeof requestDetailsSchema>;
const start = "Сведения об обращении (v1)";
const end = "Конец сведений";
const bankFields = {bankKind:"Действие по безналу",company:"Организация или плательщик",amount:"Сумма, ₽",paymentDate:"Дата поступления платежа",invoiceNumber:"Номер счёта",orderNumber:"Номер заказа по безналу",paymentPurpose:"Назначение платежа"} as const;
export const BANK_KIND_LABELS = {invoice:"Выставить счёт",payment:"Разобраться с платежом",other:"Другое"} as const;

// Human-readable description block, stored by the existing scalar service. No
// schema migration, new permission source or hidden executable HTML is involved.
export function encodeRequestDescription(description: string | null | undefined, details?: RequestDetails): string | null {
  if (!details) return description ?? null;
  const value = requestDetailsSchema.parse(details);
  const fields = [start, `Направление: ${value.kind}`, `Категория: ${value.category}`,
    ...(value.order ? [`Номер заказа: ${value.order}`] : []), ...(value.phone ? [`Телефон клиента: ${value.phone}`] : []),
    ...(value.client ? [`Клиент: ${value.client}`] : []), ...(value.want ? [`Пожелание: ${value.want}`] : []),
    ...Object.entries(bankFields).flatMap(([key,label]) => {const item=value[key as keyof typeof bankFields];return item===undefined?[]:[`${label}: ${key==='paymentPurpose'?JSON.stringify(item):item}`];}), end];
  return fields.join("\n") + "\n\n" + (description ?? "");
}
export function decodeRequestDescription(description?: string | null): { details: RequestDetails | null; body: string } {
  const text = description ?? "";
  if (!text.startsWith(start+"\n")) return {details:null,body:text};
  const index=text.indexOf("\n"+end+"\n\n");
  if(index<0)return {details:null,body:text};
  const fields=new Map(text.slice(start.length+1,index).split("\n").map(row=>{const i=row.indexOf(": ");return [row.slice(0,i),row.slice(i+2)];}));
  const bank: Record<string,unknown> = {};
  for(const [key,label] of Object.entries(bankFields)) {
    if(!fields.has(label))continue;
    const value=fields.get(label)!;
    if(key==='paymentPurpose'){try{bank[key]=JSON.parse(value);}catch{return {details:null,body:text};}}
    else bank[key]=value;
  }
  const parsed=requestDetailsSchema.safeParse({...bank,kind:fields.get("Направление"),category:fields.get("Категория"),order:fields.get("Номер заказа"),phone:fields.get("Телефон клиента"),client:fields.get("Клиент"),want:fields.get("Пожелание")});
  return parsed.success?{details:parsed.data,body:text.slice(index+end.length+3)}:{details:null,body:text};
}
export function isUrgentRequest(value: unknown): boolean { return typeof value === "string" && ["CRITICAL","URGENT","HIGH"].includes(value.toUpperCase()); }
export function isClaimProject(name?: string | null): boolean {return /претенз|жалоб/i.test(name??"");}
export function crmOrderUrl(order: string): string | null {return /^\d{1,20}$/.test(order)?`https://basav2.lenremont.com/requests/${order}`:null;}

export function isBeznalProject(name?: string | null): boolean { return /^безнал\s+оп$/iu.test((name ?? "").trim()); }
