import { describe,it,expect } from "vitest";
import {searchSegments,searchSnippet,readableSearchDescription,taskSearchContext,matchesTaskSearch} from "./search-context";
import {encodeRequestDescription} from "./request-presentation";
describe("shared search context",()=>{
 it("centers late Cyrillic matches instead of keeping only the beginning",()=>{
  const text="Начало без совпадения. ".repeat(45)+"Оплата поступила за договор Альфа";
  const snippet=searchSnippet(text,"оплата Альфа");expect(snippet).toContain("Оплата");expect(snippet).toContain("Альфа");expect(snippet.startsWith("…")).toBe(true);expect(snippet.length).toBeLessThan(220);
 });
 it("highlights each case-insensitive Unicode word without losing literal text",()=>{
  const text="<img onerror=alert(1)> Анна оплатила Альфа";const parts=searchSegments(text,"АННА Альфа");expect(parts.map(p=>p.text).join("")).toBe(text);expect(parts.filter(p=>p.matched).map(p=>p.text)).toEqual(["Анна","Альфа"]);
 });
 it("preserves empty query",()=>expect(searchSegments("Тема <текст>","")).toEqual([{text:"Тема <текст>",matched:false}]));
 it("excludes typed-block framing but searches readable form fields",()=>{
  const description=encodeRequestDescription("Получили оплату",{kind:"beznal",category:"Безнал",company:"ООО Альфа"});expect(readableSearchDescription(description)).toBe("Получили оплату");
  const task={id:"task-1",title:"Заявка",description};expect(taskSearchContext(task,"Альфа")).toEqual([{label:"Организация",text:"ООО Альфа"}]);expect(taskSearchContext(task,"v1")).toEqual([]);
 });
 it("matches words across visible fields and excludes stale legacy people for canonical requests",()=>{
  const task={id:"task-1",title:"Оплата",description:"Поступление",createdBy:{name:"Старый автор"},request:{author:{name:"Анна"}}};expect(matchesTaskSearch(task,"Анна оплата")).toBe(true);expect(matchesTaskSearch(task,"Старый")).toBe(false);
 });
 it("covers readable payment amounts and dates without exposing form framing",()=>{
  const task={id:"task-1",title:"Безнал",description:encodeRequestDescription("",{kind:"beznal",category:"Безнал",amount:"125000",paymentDate:"2026-10-29",bankKind:"payment"})};
  expect(matchesTaskSearch(task,"125000 2026-10-29")).toBe(true);
  expect(taskSearchContext(task,"125000")[0]).toEqual({label:"Сумма, ₽",text:"125000"});
  expect(taskSearchContext(task,"платежом")[0]).toEqual({label:"Действие по безналу",text:"Разобраться с платежом"});
 });
 it("does not invent a department or field match",()=>expect(taskSearchContext({id:"x",title:"Тема"},"бухгалтерия")).toEqual([]));
 it("keeps a distant second word in a separate bounded context window",()=>{
  const snippet=searchSnippet("Анна "+"описание ".repeat(100)+" Альфа", "Анна Альфа");expect(snippet).toContain("Анна");expect(snippet).toContain("Альфа");expect(snippet.length).toBeLessThan(200);
 });
});
