import {describe,it,expect} from "vitest";
import {encodeRequestDescription,decodeRequestDescription,requestDetailsSchema,crmOrderUrl,isUrgentRequest} from "./request-presentation";
describe('request presentation',()=>{
 it('round-trips a claim and body without changing useful data',()=>{const details={kind:'claim' as const,category:'Цена',order:'5305316',phone:'+7 000 000-00-00',client:'Синтетический клиент',want:'Возврат'};const encoded=encodeRequestDescription('Описание',details);expect(decodeRequestDescription(encoded)).toEqual({details,body:'Описание'});expect(crmOrderUrl(details.order)).toBe('https://basav2.lenremont.com/requests/5305316');});
 it('keeps ordinary legacy descriptions untouched',()=>{expect(decodeRequestDescription('<p>Текст</p>')).toEqual({details:null,body:'<p>Текст</p>'});});
 it('rejects forged fields, line injection, missing claim contacts and executable orders',()=>{expect(requestDetailsSchema.safeParse({kind:'claim',category:'Цена',order:'123'}).success).toBe(false);expect(requestDetailsSchema.safeParse({kind:'it',category:'A\nНомер заказа: 12'}).success).toBe(false);expect(requestDetailsSchema.safeParse({kind:'it',category:'A',authorId:'forged'}).success).toBe(false);expect(crmOrderUrl('javascript:alert(1)')).toBeNull();});
 it('groups historical priorities without rewriting values',()=>{for(const value of ['HIGH','URGENT','CRITICAL'])expect(isUrgentRequest(value)).toBe(true);for(const value of ['LOW','MEDIUM','unknown',null])expect(isUrgentRequest(value)).toBe(false);});
});
