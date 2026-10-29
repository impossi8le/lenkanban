import type { ProblemReportReason } from "@/lib/telemetry/problem-report-contract";
export const problemReportReasons: Array<{ value: ProblemReportReason; label: string }> = [
  { value: "slow", label: "Медленно работает" }, { value: "button", label: "Не работает кнопка или действие" },
  { value: "error", label: "Ошибка на экране" }, { value: "other", label: "Другая проблема" },
];
export function problemReportReasonLabel(reason?: string): string {
  return problemReportReasons.find(item => item.value === reason)?.label ?? "Причина не указана";
}
export function problemReportScreenLabel(screen?: string): string {
  return ({ home: "Главная", board: "Доска обращений", "task.detail": "Карточка обращения", "my-tasks": "Мои обращения",
    inbox: "Входящие", messages: "Сообщения", analytics: "Аналитика", settings: "Настройки", admin: "Управление",
    "admin.telemetry": "Диагностика", login: "Вход", register: "Регистрация" } as Record<string, string>)[screen ?? ""] ?? "Рабочее пространство";
}
