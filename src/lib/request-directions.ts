/** Presentation classification only; creation rights still come from the server. */
export function classifyDirectionName(name:string):"support"|"claim"|"beznal"|null{
 const value=name.trim().toLowerCase();
 if(/^безнал\s+оп$/u.test(value))return "beznal";
 if(/претенз|жалоб|рекламац|недовольн/.test(value))return 'claim';
 if(/техподдерж|поддержк|helpdesk|support/.test(value)||/(^|[^а-яё])ит([^а-яё]|$)/.test(value))return 'support';
 if(/клиент/.test(value))return 'claim';return null;
}

/** Public presentation only. Aliases resolve authorized board IDs per request. */
export const REQUEST_DEPARTMENTS = [
  { kind: "beznal", name: "Безнал ОП", title: "Обращение в Безнал ОП", hint: "Выставить счёт, определить платёж, передать информацию" },
  { kind: "support", name: "Техподдержка и ИТ", title: "Написать в Техподдержку", hint: "Сбой программы, телефонии, компьютера, доступы" },
  { kind: "claim", name: "Претензии клиентов", title: "Передать недовольного клиента", hint: "Жалоба на мастера, возврат, срочный звонок ОЗОК" },
] as const;
export type RequestDepartmentKind = typeof REQUEST_DEPARTMENTS[number]["kind"];
export function departmentHref(kind: RequestDepartmentKind, create = false) {
  return `/departments/${kind}${create ? "?create=task" : ""}`;
}
