import { describe, expect, it } from "vitest";
import {
  announceCancel,
  announceMove,
  announceMoveError,
  announceMoveUnchanged,
  getMoveErrorFeedback,
} from "./move-announcements";

describe("move announcements", () => {
  it("explains unavailable exact placement without disclosing hidden anchors or promising that refresh alone fixes it", () => {
    const error = Object.assign(new Error("hidden-anchor-private-title"), { status: 422, payload: { error: {
      code: "INVALID_MOVE_NEIGHBORS", message: "hidden-anchor-private-title", details: { taskId: "hidden-anchor-id", count: 12 },
    } } });
    expect(getMoveErrorFeedback(error)).toEqual({
      title: "Не удалось определить место в колонке",
      description: "Порядок задач восстановлен. Обновите доску. Если ошибка повторяется, обратитесь к ответственному за доску.",
    });
    const announcement = announceMoveError("Моя задача", error);
    expect(announcement).toContain("не удалось определить точное место в колонке");
    expect(announcement).toContain("обратитесь к ответственному за доску");
    expect(JSON.stringify(getMoveErrorFeedback(error)) + announcement).not.toMatch(/hidden-anchor|12/);
  });
  it("announces a completed move in Russian with human-readable context", () => {
    expect(
      announceMove({
        title: "Исправить авторизацию",
        fromColumn: "К выполнению",
        toColumn: "В работе",
        position: 2,
        total: 5,
      }),
    ).toBe(
      "Задача «Исправить авторизацию» перемещена из «К выполнению» " +
        "в «В работе», позиция 2 из 5.",
    );
  });

  it("announces cancellation in Russian", () => {
    expect(announceCancel("Исправить авторизацию")).toBe(
      "Перемещение задачи «Исправить авторизацию» отменено.",
    );
  });

  it("never exposes an internal task ID", () => {
    const internalTaskId = "task_01JY8X7Q3NH6E4HZCFM9X5G8AW";
    const output = announceMove({
      taskId: internalTaskId,
      title: "Исправить авторизацию",
      fromColumn: "К выполнению",
      toColumn: "В работе",
      position: 2,
      total: 5,
    });

    expect(output).not.toContain(internalTaskId);
  });

  it("announces a failed move as an error rather than a cancellation", () => {
    expect(announceMoveError("Исправить авторизацию")).toBe(
      "Не удалось переместить задачу «Исправить авторизацию». " +
        "Порядок восстановлен. Попробуйте ещё раз.",
    );
  });

  it("explains a version conflict separately from a network or server failure", () => {
    const conflict = Object.assign(new Error("stale version"), {
      status: 409,
      payload: {
        error: {
          code: "STALE_TASK_VERSION",
        },
      },
    });

    expect(announceMoveError("Исправить авторизацию", conflict)).toBe(
      "Не удалось сохранить перемещение задачи «Исправить авторизацию»: " +
        "задачу уже изменили. Порядок восстановлен. Обновите доску и повторите попытку.",
    );
    expect(getMoveErrorFeedback(conflict)).toEqual({
      title: "Задача уже изменена",
      description:
        "Порядок задач восстановлен. Обновите доску и повторите попытку.",
    });
    expect(
      announceMoveError(
        "Исправить авторизацию",
        new TypeError("Failed to fetch"),
      ),
    ).toBe(
      "Не удалось сохранить перемещение задачи «Исправить авторизацию»: " +
        "нет соединения с сервером. Порядок восстановлен. " +
        "Проверьте подключение и попробуйте ещё раз.",
    );
  });

  it("does not conflate an operation-id conflict with a stale task", () => {
    const operationConflict = Object.assign(new Error("operation reused"), {
      status: 409,
      payload: {
        error: {
          code: "OPERATION_ID_REUSED",
        },
      },
    });

    expect(announceMoveError("Исправить авторизацию", operationConflict)).toBe(
      "Не удалось сохранить перемещение задачи «Исправить авторизацию»: " +
        "операция уже была использована. Порядок восстановлен. Повторите попытку.",
    );
    expect(getMoveErrorFeedback(operationConflict)).toEqual({
      title: "Конфликт операции перемещения",
      description:
        "Порядок задач восстановлен. Повторите перемещение ещё раз.",
    });
  });

  it("provides distinct visual and a11y feedback for network and server failures", () => {
    const networkError = new TypeError("Failed to fetch");
    const serverError = Object.assign(new Error("service unavailable"), {
      status: 503,
      payload: {
        error: {
          code: "INTERNAL_ERROR",
        },
      },
    });

    expect(getMoveErrorFeedback(networkError)).toEqual({
      title: "Нет соединения с сервером",
      description:
        "Порядок задач восстановлен. Проверьте подключение и попробуйте ещё раз.",
    });
    expect(announceMoveError("Исправить авторизацию", networkError)).toContain(
      "нет соединения с сервером",
    );
    expect(getMoveErrorFeedback(serverError)).toEqual({
      title: "Сервер не сохранил перемещение",
      description:
        "Порядок задач восстановлен. Попробуйте ещё раз позже.",
    });
    expect(announceMoveError("Исправить авторизацию", serverError)).toContain(
      "сервер временно недоступен",
    );
  });

  it("announces a no-op without claiming that it needs persistence", () => {
    expect(announceMoveUnchanged("Исправить авторизацию")).toBe(
      "Задача «Исправить авторизацию» осталась на прежнем месте. " +
        "Сохранение не требуется.",
    );
  });

  it("never exposes an internal task ID in a move error", () => {
    const internalTaskId = "task_01JY8X7Q3NH6E4HZCFM9X5G8AW";

    expect(announceMoveError("Исправить авторизацию")).not.toContain(
      internalTaskId,
    );
  });
});
