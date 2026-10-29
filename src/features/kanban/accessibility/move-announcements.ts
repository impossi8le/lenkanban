export interface MoveAnnouncementInput {
  taskId?: string;
  title: string;
  fromColumn: string;
  toColumn: string;
  position: number;
  total: number;
}

export function announceMove({
  title,
  fromColumn,
  toColumn,
  position,
  total,
}: MoveAnnouncementInput): string {
  return (
    `Задача «${title}» перемещена из «${fromColumn}» ` +
    `в «${toColumn}», позиция ${position} из ${total}.`
  );
}

export function announceCancel(title: string): string {
  return `Перемещение задачи «${title}» отменено.`;
}

export interface MoveErrorFeedback {
  title: string;
  description: string;
}

type MoveFailureKind =
  | "invalid-neighbors"
  | "stale-task"
  | "operation-reused"
  | "conflict"
  | "network"
  | "server"
  | "generic";

function responseCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("payload" in error)) {
    return undefined;
  }

  const payload = (error as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return undefined;
  }

  const apiError = (payload as { error?: unknown }).error;
  if (!apiError || typeof apiError !== "object" || !("code" in apiError)) {
    return undefined;
  }

  const code = (apiError as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function moveFailureKind(error: unknown): MoveFailureKind {
  switch (responseCode(error)) {
    case "INVALID_MOVE_NEIGHBORS":
      return "invalid-neighbors";
    case "STALE_TASK_VERSION":
      return "stale-task";
    case "OPERATION_ID_REUSED":
      return "operation-reused";
  }

  const status = responseStatus(error);
  if (status === 409) {
    return "conflict";
  }
  if (typeof status === "number" && status >= 500) {
    return "server";
  }
  if (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "TypeError")
  ) {
    return "network";
  }
  return "generic";
}

export function getMoveErrorFeedback(error?: unknown): MoveErrorFeedback {
  switch (moveFailureKind(error)) {
    case "invalid-neighbors":
      return {
        title: "Не удалось определить место в колонке",
        description:
          "Порядок задач восстановлен. Обновите доску. Если ошибка повторяется, обратитесь к ответственному за доску.",
      };
    case "stale-task":
      return {
        title: "Задача уже изменена",
        description:
          "Порядок задач восстановлен. Обновите доску и повторите попытку.",
      };
    case "operation-reused":
      return {
        title: "Конфликт операции перемещения",
        description:
          "Порядок задач восстановлен. Повторите перемещение ещё раз.",
      };
    case "conflict":
      return {
        title: "Конфликт при перемещении",
        description:
          "Порядок задач восстановлен. Обновите доску и повторите попытку.",
      };
    case "network":
      return {
        title: "Нет соединения с сервером",
        description:
          "Порядок задач восстановлен. Проверьте подключение и попробуйте ещё раз.",
      };
    case "server":
      return {
        title: "Сервер не сохранил перемещение",
        description:
          "Порядок задач восстановлен. Попробуйте ещё раз позже.",
      };
    default:
      return {
        title: "Не удалось переместить задачу",
        description: "Порядок задач восстановлен. Попробуйте ещё раз.",
      };
  }
}

export function announceMoveUnchanged(title: string): string {
  return (
    `Задача «${title}» осталась на прежнем месте. ` +
    "Сохранение не требуется."
  );
}

function responseStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return undefined;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function announceMoveError(title: string, error?: unknown): string {
  switch (moveFailureKind(error)) {
    case "invalid-neighbors":
      return (
        `Не удалось сохранить перемещение задачи «${title}»: ` +
        "не удалось определить точное место в колонке. Порядок восстановлен. " +
        "Обновите доску. Если ошибка повторяется, обратитесь к ответственному за доску."
      );
    case "stale-task":
      return (
        `Не удалось сохранить перемещение задачи «${title}»: ` +
        "задачу уже изменили. Порядок восстановлен. Обновите доску и повторите попытку."
      );
    case "operation-reused":
      return (
        `Не удалось сохранить перемещение задачи «${title}»: ` +
        "операция уже была использована. Порядок восстановлен. Повторите попытку."
      );
    case "conflict":
      return (
        `Не удалось сохранить перемещение задачи «${title}»: ` +
        "возник конфликт изменений. Порядок восстановлен. Обновите доску и повторите попытку."
      );
    case "network":
      return (
        `Не удалось сохранить перемещение задачи «${title}»: ` +
        "нет соединения с сервером. Порядок восстановлен. Проверьте подключение и попробуйте ещё раз."
      );
    case "server":
      return (
        `Не удалось сохранить перемещение задачи «${title}»: ` +
        "сервер временно недоступен. Порядок восстановлен. Попробуйте ещё раз позже."
      );
  }

  return (
    `Не удалось переместить задачу «${title}». ` +
    "Порядок восстановлен. Попробуйте ещё раз."
  );
}
