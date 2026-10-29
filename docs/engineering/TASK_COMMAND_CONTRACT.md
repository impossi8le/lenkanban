# Команды Task: версия, аудит и повтор

Волна14, #65. Первый исполняемый срез — details-save существующей задачи. Новый lifecycle/приватность не включаются; scoped/applicant решения остаются prospective.

## HTTP и совместимость

PATCH /api/tasks/[id] распознаёт instrumented intent по наличию operationId или changes. Его strict body: {operationId: UUID, expectedVersion: integer0..2147483647, changes:{title?,description?,priority?,deadline?}}. changes strict, непустой; title trim1..200, description trim<=50000 или null, priority существующий enum, deadline ISO datetime или null. Никаких columnId/status/position или неизвестных полей. Неверные/неполные metadata никогда не попадают в legacy fallback. Старый плоский mixed PATCH без этих discriminators остаётся совместимым и явно НЕ получает обещаний нового протокола. Другие legacy writers пока не переведены; TaskRequest marker не создаётся.

Для новой команды auth до чтения body, ограничение256KiB/5сек, same-origin cookie mutation; проверенный bearer без Origin допускается, foreign Origin отклоняется. Ответы no-store, фиксированные безопасные ошибки через существующие api helpers/logging. Ошибки не включают названия/описания/raw body. PATCH возвращает ACK {taskId,projectId,version,changed,replayed}, без содержимого задачи. GET ?view=details — авторизованное актуальное чтение полной карточки с прежней минимизацией user DTO; обычный GET сохраняет прежний минимальный ответ. Fresh identity и существующий project-access проверяются сервером; новые org metadata не дают прав.

## Одна транзакция

Один общий createTaskCommandService, использующий существующие prisma/project-access/Activity; новый receipt не заменяет Activity. ReadCommitted: сериализация actor+operationId advisory → идентификация ресурса → Project FOR UPDATE → текущий Column FOR UPDATE → Task FOR UPDATE с повторной проверкой идентичности → fresh actor (удерживаемый FOR SHARE) → existing project-access → receipt lookup. Порядок ресурсов совместим с canonical DnD/relocation Project→Column→Task; rank/position/status не меняются. Identity drift отклоняется. Auth обязателен и перед replay. Сохраняется прежняя legacy политика доступа, без scoped enforcement.

TaskCommandOperation не имеет cascade FK: actorId+operationId unique, task/project IDs, normalized SHA256 fingerprint(method/task/changes/expectedVersion), expectedVersion, committedVersion и changed; без содержимого и снимка Task. UUID с другим fingerprint даёт409. Replay возвращает прежний ACK и не мутирует/не повторяет Activity/effects. При отсутствии receipt expectedVersion должен совпасть с Task.version; CAS increment ровно1 при изменении. No-op получает receipt без task write/updatedAt/version increment. Overflow отклоняется до mutation. Изменившиеся поля используют awaited logActivityWithClient в той же tx; audit/receipt failure откатывает всё. Business receipts не удаляются по telemetry TTL. Переносы используют прежний canonical механизм; второго rank/permission/history engine нет.

Внешние эффекты только после commit и только первого changed результата, через прежние emit/automation paths. Exactly-once внешней доставки не обещается; rollback не вызывает effects, replay их не дублирует. После ошибки effect подтверждённый receipt не отменяется. Ошибки effects очищаются существующим logger, без raw содержимого.

## Первый UI consumer — снимок волны14

Модальная карточка board использует один scalar save transport. Фиксирует UUID/actionId/version/normalized changes при исходном intent; отправляет только изменяемые поля, не случайный stale title из старых callbacks. Не более одной unresolved команды. Unknown network/5xx сохраняет exact body и correlation для явного retry;409 требует актуального чтения и нового явного intent, без автоматического rebase/retry. Success/replay — authoritative GET details, без применения исторического ACK как Task. Ошибка refetch не повторяет мутацию; отдельный retry чтения. Новая исходная task identity/session очищает pending state. Server page передаёт initialActorId из requireDbUser; несовпадение с client session скрывает старый snapshot и требует свежей загрузки страницы. Это защищает также первую hydration после смены аккаунта; component-only fixtures могут использовать локальный actor latch. Column move остаётся legacy/canonical и не смешивается с scalar command. Остальные consumers остаются legacy, это ограничение явно отражается в отчёте.

## Владение и доказательства

Волна15 расширяет только потребителей: общий TaskCommandPanel извлекает уже работающий boardmodal controller (session/actor gate, status/retry UI, delete guard и existing useTaskScalarCommand); boardmodal и standalone передают исходный server actor и разные navigation callbacks. Это один controller/transport, не новый command engine. Standalone server page передаёт initialActorId из requireDbUser. «Мои задачи» использует actor-scoped list/detail query keys с enabled только после authenticated session, selection identity включает actor/project/task; неполный list row не приводится к полной Task через any. До показа/редактирования карточки выполняется GET?view=details; закрытие/смена selection/actor не применяет поздние ответы или callbacks к другому ресурсу. При unknown/saving/conflict/readFailed backdrop/Escape/delete/переключение не обходят общий unresolved gate. Успешное authoritative чтение инвалидирует нужный actor-scoped список, без merge исторического ACK. Full-page close→board и modal back сохраняют прежние назначения; my-tasks close закрывает локальную панель. Все три consumers используют тот же протокол. Schema/API/legacy writers/lifecycle в этой волне не расширяются.

Владение wave15: backlog_dependencies — shared TaskCommandPanel, modal/standalone/server actor binding, useTaskScalarCommand optional authoritative-read callback при необходимости; logging_foundation — my-tasks page/own detail loader через общий panel, без shared edits; testing_foundation — независимые consumer tests и существующие shared regression fixtures. Root — контракт/review/gates/browser/reports, production не правит параллельно без передачи владения. Все source changes стартуют после этого дополнения; запрещённые внешние передачи/БД по-прежнему не выполняются.

Историческое владение wave14: logging_foundation — schema/migration/service/HTTP route/validators и backend integration. backlog_dependencies — modal consumer/new client transport/component tests. testing_foundation — отдельные независимые command/API/guarded PG tests; production/schema не правит. Root — контракт, независимое review, offline SQL, общие gates/QA/reports. Миграция только подготовлена, рабочие данные не трогаются. Проверки включают fresh auth/replay, UUID/version conflicts, no-op/CAS/overflow, обязательный audit, bounded HTTP/origin, unknown exact retry/refetch и неизменность canonical move. Моки не доказывают PostgreSQL rollback/concurrency; guarded suite skip без разрешённой изолированной БД.

## Фактическая граница редактирования marked-заявок, 26.10.2026

Исправление доступности редакторов не расширяет продуктовую матрицу
`REQUEST_LIFECYCLE.md` и не вводит новую команду `edit_fields`.
Legacy scalar PATCH и PUT исполнителей отклоняют marked TaskRequest;
`REQUEST_LIFECYCLE_NOT_ENABLED` означает неподдержанный путь изменения,
а не доказанный конфликт версии. Карточка использует возможности из уже
существующего actor-scoped GET lifecycle: описание — по canonical planner,
остальные legacy редакторы доступны только unmarked-задачам с правом записи.
Загрузка/ошибка/смена аккаунта не дают права редактирования. Отказ изменения
приоритета возвращает последнее подтверждённое значение; повтор старого
изменения после восстановления не выполняется автоматически.

Остаётся незакрытый implementation gap: canonical service пока не реализует
изменение темы, приоритета и срока marked-заявки для исполнителя/руководителя
по разрешениям доски. Право фактического исполнителя на срок, описанное в
`UI_SIMPLIFICATION_2026-10-23.md`, этим исправлением не отменяется и не считается
реализованным. Канонические назначение и переходы, включая взятие в работу,
сохраняются. Для закрытия gap нужны отдельная реализация общей guarded-команды
и проверки прав/состояния/CAS/повторов, без ослабления существующих guards.
