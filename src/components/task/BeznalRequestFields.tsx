"use client";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Textarea} from "@/components/ui/textarea";
import {BANK_KIND_LABELS, type RequestDetails} from "@/lib/request-presentation";

export type BeznalFields = Pick<RequestDetails,"bankKind"|"company"|"amount"|"paymentDate"|"invoiceNumber"|"orderNumber"|"paymentPurpose">;
export function BeznalRequestFields({id,value,onChange,disabled}:{id:string;value:BeznalFields;onChange:(value:BeznalFields)=>void;disabled:boolean}) {
 const update=(key:keyof BeznalFields,text:string)=>onChange({...value,[key]:text});
 return <section className="request-bank-details" aria-labelledby={`${id}-bank-heading`}>
  <h3 id={`${id}-bank-heading`} className="text-xl font-semibold">Данные по безналу</h3>
  <p className="text-muted-foreground">Все поля ниже необязательные. Заполните, что известно, — остальное можно пропустить.</p>
  <fieldset disabled={disabled}><legend className="font-medium">Что нужно сделать <span className="block font-normal text-muted-foreground">(необязательно)</span></legend>
   <div className="mt-2 flex flex-wrap gap-2">{Object.entries(BANK_KIND_LABELS).map(([kind,label])=><button key={kind} type="button" aria-pressed={value.bankKind===kind} onClick={()=>update("bankKind",value.bankKind===kind?"":kind)} className={`min-h-11 rounded-lg border px-3 text-base ${value.bankKind===kind?'border-primary bg-accent text-accent-foreground':'bg-card'}`}>{label}</button>)}</div>
  </fieldset>
  <div className="request-bank-grid">
   {([{key:"company",label:"Организация или плательщик",placeholder:'Например, ООО «Вектор»',full:true},{key:"amount",label:"Сумма, ₽",placeholder:"Например, 125 000",inputMode:"decimal"},{key:"paymentDate",label:"Дата поступления платежа",type:"date"},{key:"invoiceNumber",label:"Номер счёта",placeholder:"Если известен"},{key:"orderNumber",label:"Номер заказа",placeholder:"Если известен"}] as const).map(field=><div className={`request-bank-field ${'full' in field?'request-bank-field--full':''}`} key={field.key}>
    <Label htmlFor={`${id}-${field.key}`}>{field.label}{" "}<span className="block font-normal text-muted-foreground">(необязательно)</span></Label>
    <Input id={`${id}-${field.key}`} value={value[field.key]??""} onChange={event=>update(field.key,event.target.value)} disabled={disabled} type={'type' in field?field.type:'text'} inputMode={'inputMode' in field?field.inputMode:undefined} placeholder={'placeholder' in field?field.placeholder:undefined} maxLength={field.key==='amount'?40:200}/>
   </div>)}
   <div className="request-bank-field request-bank-field--full"><Label htmlFor={`${id}-paymentPurpose`}>Назначение платежа{" "}<span className="block font-normal text-muted-foreground">(необязательно)</span></Label><Textarea id={`${id}-paymentPurpose`} value={value.paymentPurpose??""} onChange={event=>update("paymentPurpose",event.target.value)} maxLength={1000} rows={3} disabled={disabled} placeholder="Можно скопировать из платёжного документа"/></div>
  </div>
 </section>;
}
