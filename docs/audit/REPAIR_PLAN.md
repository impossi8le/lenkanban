# План исправлений и регрессионной приемки ЛЕНКАНБАН

> Для исполнителя: выполнять по задачам через `superpowers:executing-plans`; отметки ниже относятся к будущей реализации. Этот документ не запускает исправления и не разрешает сброс рабочей БД.

**Цель:** устранить issues #31–#42 и дополнительные UX-задачи #49–#52, проверить целостный пользовательский сценарий доски в V2 и legacy без потери данных и регрессии прав. Документация аудита публикуется в PR #53; исправления остаются отдельной работой.

**Архитектура:** источник истины — корневые `src/` и `prisma/`. Общие правила доступа, мутаций и событий должны использоваться HTTP, DnD, автоматизациями и повторениями. Состояние после reconnect восстанавливается каноническим чтением API; Socket.IO не заменяет БД и не гарантирует доставку.

**Стек:** Next.js App Router, TypeScript, React, Prisma/PostgreSQL, Socket.IO, Vitest/Testing Library, Playwright.

**Основание:** [функциональный аудит](FUNCTIONAL_AUDIT.md), [архитектура](ARCHITECTURE.md), [навигация и дизайн](NAVIGATION_AND_DESIGN.md), issues #31–#42. Номера issues являются внешними идентификаторами; полные URL добавляются главным отчетом после проверки репозитория.

## Границы и чтение результатов

Production-код этим документом не изменяется. Не внедрять заодно новые роли, LDAP, подразделения, почтовый импорт или смену DnD-библиотеки. Роль read-only сейчас отсутствует: MEMBER имеет право писать; не считать это багом без отдельного требования.

| Метка | Значение | Как использовать |
| --- | --- | --- |
| FAIL setup | Тестовый файл не загрузился, missing dependency, неверная среда или конфигурация | Исправить окружение; проверяемая возможность имеет статус BLOCKED, а не «функция сломана» |
| FAIL product | Тело теста/сценарий реально выполнено, проверяемый контракт нарушен | Сохранить вход, ожидание, фактическое состояние и воспроизведение; открыть/уточнить issue |
| PASS unit/component | Контракт подтвержден в заданной изолированной модели | Не распространять на реальную БД, Socket.IO, браузер или роли вне fixture |
| PASS HTTP/API | Получен ожидаемый HTTP-ответ и проверены конкретные данные | Не доказывает визуальную работоспособность, доступность, доставку событий или полное сохранение всех связей |
| PASS browser | Проверены пользовательское действие и наблюдаемый результат в браузере | Указать viewport, роль, режим DnD; отдельно проверять persisted state после reload |
| SKIP / NOT RUN | Сценарий не выполнялся либо пропущен | Не включать в число прошедших; записать причину и следующий необходимый шаг |

На момент аудита `npm test` не исполнил ни одного теста: 150 файлов остановились в setup из-за отсутствующего `@testing-library/dom`. Это не 150 продуктовых регрессий. Typecheck и lint также FAIL; нельзя называть baseline зеленым. Отдельно чистым исполнением исходных расчетов подтверждены ошибки дат и CRITICAL comparator.

Историческая сводка проверки содержит **30/30 PASS** проверок HTTP/API ожиданий, включая ожидаемые 404 отсутствующих страниц/upload. Намеренный admin=404 для обычного USER повторно проверен по контракту; исходное ожидание 403 было ошибкой smoke и исправлено. Подробности: [LIVE_VALIDATION.md](LIVE_VALIDATION.md). Ответ 200 страницы не означает, что меню, модальное окно, drag/drop и сохранение работают в браузере. Эти результаты дополняют, но не заменяют матрицу ниже.

## Изолированная среда для реализации

1. Завести PostgreSQL, у которого имя БД содержит `_test`, а hostname отличается от `DATABASE_URL` и `PRODUCTION_DATABASE_URL`: именно такие ограничения проверяют существующие integration tests. Отдельная БД на том же hostname текущую защиту не пройдет; не ослаблять проверку ради запуска. Использовать отдельный контейнер/адрес с проверенным владельцем и назначением.
2. Перед любыми schema/seed/reset вывести только безопасные host/database, сверить, что это тестовый экземпляр. Пароли, токены, cookie и connection strings в evidence не писать. Не использовать рабочий `.env` как настройки тестового процесса.
3. Выделить HTTP и Socket.IO порты, отдельные секреты NextAuth/cron/internal emit, тестовый storage namespace/каталог и mail sink. `TEST_DATABASE_URL` — для integration; приложение E2E также должно иметь свой `DATABASE_URL`, явно указывающий на этот экземпляр.
4. Применить миграции/схему и минимальные fixtures только туда. Fixtures: владелец, MEMBER, PROJECT_ADMIN, глобальный ADMIN, посторонний пользователь; проекты A/B; четыре workflow-колонки и пустая колонка; задачи с разными rank/датами/всеми пятью приоритетами, тегами, исполнителями, чатом.
5. Каждый прогон имеет уникальный run ID; очищает только свои сущности/файлы после проверки. При невозможности доказать изоляцию DB/E2E остаются NOT RUN, unit/component можно продолжать.

## Очередность и зависимости

| Этап | Issues | Условие начала / результат |
| --- | --- | --- |
| 1. Достоверная база проверки | #31 test setup → #32 globs/lint | До массовых продуктовых правок; root suite исполняет тела, дубль отделен, typecheck/lint имеют объяснимый результат |
| 2. Закрыть входы и восстановить основной путь | #38 endpoint auth; #33 navigation; #34 uploads | После #31/#32 для regression gates; исправление fail-open #38 можно приоритизировать немедленно, проверку все равно завершить |
| 3. Единые мутации и доставка | #41 auto mutations → #35 DnD automation; #40 realtime | Определить version/Activity/emit и retry до подключения триггеров; #40 можно начать после согласования event contract #41 |
| 4. Даты и надежные повторения | #37 dates → #39 recurrence atomic | #39 использует проверенный расчет #37 и доступ #38; realtime после commit согласуется с #40/#41 |
| 5. Представления и пользовательская приемка | #36 sort → #42 views/admin | Единый sort/filter contract до сохраненных представлений; navigation и роли из этапа 2 уже определены |
| 6. Общая регрессия | Все #31–#42, #49–#52 | Browser V2/legacy, API, роль, reconnect и persisted state; выпуск только с перечисленными открытыми ограничениями |

Это зависимости контрактов, не требование одного гигантского PR. Каждое исправление должно проходить собственный минимальный цикл ниже; тяжелые проверки выполнять последовательно. Не повторять полную suite после чисто редакционной правки, если она не затрагивает проверяемое поведение.

## Задачи исправления

Для каждой задачи: сначала воспроизводящий meaningful test, затем минимальное исправление, затем этот тест и ближайшие затронутые существующие проверки. Тест, который лишь копирует comparator/условие из реализации, недостаточен: проверять наблюдаемое поведение или транзакционный инвариант.

### 1. #31 — восстановить тестовый setup

Файлы: `package.json`, lockfile, `src/test/setup.ts`, `vitest.config.ts`. Контракт: установка из lockfile воспроизводимо предоставляет Testing Library; Node-проект не требует DOM без причины.

- [ ] Проверить peer dependencies и устранить missing `@testing-library/dom`, сохранив согласованные версии.
- [ ] Выполнить существующий Node-тест `src/features/kanban/server/move-task-service.test.ts` и component-тест `src/components/task/TaskDetailPanel.component.test.tsx`: тела действительно исполнены, число assertions/tests больше нуля.
- [ ] Проверить `npm run typecheck` и затем `npm test`; missing setup не маскировать ignore, пустым setup либо удалением проверок.

### 2. #32 — отделить корень и разобрать lint

Файлы: `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`; перечень корневых файлов сохранён в безопасной сводке; сырой lint-отчёт исключён из публикации.

- [ ] Ограничить сбор корневым приложением; вложенные `lenkanban/` и `lenkanban/e2e/` не собираются корневой suite. Сохранять отдельно нужные server/config/tests пути.
- [ ] Проверить фактически собранный список файлов и наличие существующих root tests; нельзя получить зеленый результат исключением всей проблемной области.
- [ ] Исправлять корневые lint-ошибки по причине; 74 root errors не исчезнут от исключения дубля. Не отключать правила глобально ради счетчика.
- [ ] Выполнить последовательно typecheck, lint, test и сохранить новую root baseline: команду, exit code, число исполненных/пропущенных тестов.

### 3. #38 — fail-closed доступ к служебным endpoints

Файлы: `src/app/api/recurring-tasks/process/route.ts`, `src/app/api/test-socket-emit/route.ts`, `src/lib/require-api-user.ts`, `src/middleware.ts`; административные handlers по списку issue.

- [ ] Зафиксировать ожидаемый контракт cron/internal endpoints, включая отсутствие server secret; UI middleware не защищает `/api`.
- [ ] Минимальный route-test: нет секрета, нет/неверный bearer → отказ и ноль DB writes; корректный secret → разрешенный путь. Production debug emit закрыт/отсутствует согласно контракту.
- [ ] Проверить анонимного, обычного и глобального ADMIN для административных handlers; намеренный 404 при отказе принять как контракт без раскрытия существования ресурса.

### 4. #33 — навигация и достижимость действий

Файлы: `src/components/layout/command-palette.tsx`, `src/components/kanban/{Board,Column,Card}.tsx`, `src/features/kanban/dnd/KanbanDndBoard.tsx`, маршруты dashboard; остальные точки из NAV-02–NAV-13.

- [ ] Устранить мертвые ссылки и согласовать shortcut-подсказки с регистрацией; проверить мобильную навигацию, возврат и focus после закрытия карточки.
- [ ] В обеих досках обеспечить достижимый выбор карточек для bulk: выбор не открывает карточку и не запускает drag; отмена снимает selection.
- [ ] Минимум: компонентный тест маршрутизации/selection и один browser journey «Проекты → доска → карточка → назад», desktop и mobile. HTTP 200 не заменяет этот journey.

### 5. #34 — сквозные вложения

Файлы: `src/components/task/TaskAttachments.tsx`, `src/components/task/TaskChatPanel.tsx`, `src/app/api/tasks/[id]/attachments/route.ts`, `src/types/attachment.ts`; новый upload handler/storage adapter — только после согласования контракта issue.

- [ ] Согласовать upload → metadata → authorized download/delete; использовать один договоренный контракт для карточки и чата.
- [ ] Минимальная integration: загрузить небольшой файл, сравнить скачанные байты, reload metadata, удалить и проверить недоступность; чужой проект получает отказ до чтения/записи storage.
- [ ] Component/browser: input и drop, ошибка upload с повтором, изображение/lightbox, длинное имя, недопустимый тип/размер. Сетевой сбой не создает видимое «успешное» вложение.

### 6. #41 — общий контракт мутаций автоматизации

Файлы: `src/lib/automation-processor.ts`, `src/lib/automation-processor.test.ts`, `src/lib/activity-logger.ts`, `src/socket/board-events.ts`, task mutation handlers.

- [ ] Определить для priority/assign/tag/comment версии, Activity, события, проверку принадлежности проекту; обозначить snapshot semantics нескольких actions.
- [ ] Минимальные tests: action меняет каноническое состояние и возвращает/публикует актуальный snapshot; запрещенный чужой user/column не пишет; второе action видит состояние согласно выбранному контракту; failure виден вызывающему коду.
- [ ] Проверить idempotency повторов на выбранной границе. Не вводить рекурсивные каскады правил без явного ограничителя/контракта.

### 7. #35 — status_changed из канонического DnD

Файлы: `src/app/api/tasks/[id]/move/route.ts`, `route.test.ts`, `src/features/kanban/server/move-task-service.ts`, существующие service tests; контракт мутаций из #41.

- [ ] Подключить автоматизацию после успешного commit только при изменении workflow/status, учитывая retry `operationId`.
- [ ] Минимальный интеграционный сценарий: TODO→DONE + правило add_comment дает ровно один комментарий; повтор operationId не добавляет второй; same-column reorder/rollback дают ноль запусков.
- [ ] Пройти перемещение из V2, legacy и селектора колонки карточки: один и тот же смысл перехода дает один результат; не требовать одинакового внутреннего API.

### 8. #40 — realtime, reconnect и канонический refresh

Файлы: `src/hooks/useProjectBoard.ts`, `src/hooks/useTaskChat.ts`, `src/socket/server.ts`, `src/socket/board-events.ts`, `src/components/kanban/Board.tsx`, reconnect component tests.

- [ ] Согласовать room authorization HTTP и Socket.IO для owner/MEMBER/PROJECT_ADMIN/global ADMIN; чужой проект/задача не присоединяются.
- [ ] Минимальная двухклиентная integration: B offline, A меняет/создает/удаляет, B reconnect с ack → B получает канонический snapshot, без дублей; устаревшая version не перезаписывает новую.
- [ ] Отдельно чат: pending send/retry с одним clientId, read/reactions, черновик и повторный join; отказ join и timeout видны пользователю, восстановление не требует reload.

### 9. #37 — единый календарный расчет

Файлы: `src/app/api/recurring-tasks/route.ts`, `src/app/api/recurring-tasks/process/route.ts`, `src/app/api/recurring-tasks/[id]/route.ts`, `src/components/recurring/RecurringTaskDialog.tsx`; выделить общий чистый расчет, имя модуля согласовать при реализации.

- [ ] Зафиксировать семантику первого запуска, timezone, inclusive endDate и якорной недели для interval>1; валидировать frequency/interval/days/day/date на API.
- [ ] Минимальные параметризованные тесты: 31 января→28/29 февраля→31 марта; понедельник interval=2→через 14 дней; несколько weekdays; daily/yearly; endDate; некорректные interval=0/negative, day=32 и невалидная дата отклонены.
- [ ] Проверить общий контракт create/update/process; timezone Europe/Moscow и зона с DST, если продукт хранит локальное время. Не привязывать тест к текущей реальной дате.

### 10. #39 — атомарность и единственность occurrence

Файлы: `prisma/schema.prisma`, миграция при необходимости, `src/app/api/recurring-tasks/process/route.ts`, DB integration tests. Предусловия #37/#38.

- [ ] Выбрать атомарный claim/уникальный occurrence key и транзакцию для Task, связей и продвижения расписания; emit выполнять только после commit.
- [ ] Минимальная real PostgreSQL integration: два одновременных process вызова создают один occurrence; инъекция сбоя после Task/before schedule не оставляет полузапись; повтор восстанавливается без дубля.
- [ ] Проверить disabled/expired/no-columns, несколько due периодов и определенную политику catch-up, очистку fixtures и отсутствие доставки события rollback.

### 11. #36 — сортировка V2/legacy

Файлы: `src/components/kanban/Board.tsx`, `src/features/kanban/dnd/KanbanDndBoard.tsx`, `src/features/kanban/model/normalize-board.ts`, `src/components/kanban/FilterBar.tsx`.

- [ ] Передавать отображаемый порядок в V2, сохраняя канонические rank; добавить CRITICAL в общий порядок приоритетов.
- [ ] Минимальный параметризованный component-test для обоих режимов: реально отрисованный порядок названия/дат/priority, null deadlines, tie-breaker; V2 Set видимости не должен терять сортировку.
- [ ] Browser: сменить сортировку, изменить фильтр, вернуть «По позиции», reload; rank не переписывается. При отключенном reorder объяснение доступно с клавиатуры; разрешенное межколоночное перемещение проверено отдельно.

### 12. #42 — представления, bulk и административный UI

Файлы: `src/components/views/{TableView,CalendarView}.tsx`, `src/components/saved-views/SavedViewsPanel.tsx`, `src/app/(dashboard)/projects/[id]/board/ProjectBoardClient.tsx`, `src/app/api/saved-views/*`, `src/app/(dashboard)/admin/*`, соответствующие API.

- [ ] Определить единое состояние view/filter/sort для board/table/calendar и сохранения; смена view не применяет скрыто другой набор фильтров. CRITICAL доступен в bulk таблицы.
- [ ] Минимальный browser roundtrip: выбрать table+фильтры+sort → сохранить → сбросить → загрузить → тот же набор задач и параметры; default/public/private проверены двумя пользователями; чужой private view недоступен.
- [ ] Bulk влияет только на выбранные задачи, включая страницу пагинации; частичная ошибка не отображается полным успехом. Calendar показывает сроки и открывает ту же карточку.
- [ ] Для обычного пользователя admin-контролы скрыты/запрещены и прямой API отказывает; ADMIN видит и выполняет штатные действия. Отдельно защитить debug routes в соответствии #38.

## Матрица общей regression acceptance

| Область | Минимальный сценарий и наблюдаемое ожидание | Уровень / варианты |
| --- | --- | --- |
| Вход и права | Анонимный отказ; owner/member работают; чужой проект не читается/меняется; member не управляет участниками; PROJECT_ADMIN управляет в рамках своего проекта | Route integration + один browser вход; cookie/bearer, revoked bearer |
| Проекты/колонки | Создать/переименовать; менять порядок; последнюю удалить нельзя; непустая возвращает 409 `COLUMN_NOT_EMPTY`; перед удалением вручную перенести все задачи и повторить запрос | Integration; owner/PROJECT_ADMIN согласно контракту, отказ MEMBER на manage endpoints |
| CRUD карточки | Создать → title/description/priority/deadline/assignees/tags/checklist → reload → одинаковые значения → delete | Browser + DB readback; V2 и legacy общий путь |
| DnD позиция | Внутри/между/в пустую; несколько быстрых move; cancel; keyboard; reload сохраняет порядок | Service tests + browser V2/legacy; pointer/keyboard |
| Конфликт DnD | stale version, повтор operationId, другие neighbors, exhausted rank, rollback | Unit/service + real DB concurrency; ровно одна запись/ревизия на успешную операцию |
| Filter/sort | Колонка+priority+assignee+tag; unassigned; reset; все пять priority; null dates; visual order соответствует выбору | Component + browser V2/legacy; пустая выборка и одинаковые значения |
| Bulk | Явно выбрать две задачи; изменить; третья нетронута; снять выбор; ошибка не теряет selection | Browser обеих досок и таблицы; keyboard и paginated table |
| Представления | Board/table/calendar; save/load; private/public/default; смена проекта | Component + browser, два пользователя |
| Карточка/navigation | Прямая ссылка и intercepted panel; Back/Escape/close; dirty description/draft; focus restore | Browser desktop/mobile; 320/360px и 200% zoom |
| Вложения | Input/drop → upload → download byte equality → reload → delete; отказ чужому проекту | Storage integration + browser; ошибка и retry |
| Чат | Отправка/история/read/reaction/edit/delete; clientId retry ровно один раз; reconnect без дублей | Socket integration + два браузерных клиента |
| Автоматизации | Правило на create/status/priority/assignee/tag/deadline; наблюдаемый side effect, version/Activity/event согласованы | Processor tests + DB integration; DnD retry/rollback, cross-project params |
| Повторения | Даты из #37; due process; два worker; retry; expired/disabled; связи задачи полные | Pure time tests + isolated PostgreSQL; без реального cron ожидания |
| Realtime | A меняет/создает/удаляет, B наблюдает; disconnect B, несколько изменений A, ack reconnect, canonical refresh | Две сессии; V2/legacy; HTTP и socket права совпадают |
| Доступность | Все ключевые действия достижимы keyboard, focus виден/возвращается, DnD announcement; empty/error/loading объяснимы | Browser + axe targeted; светлая/темная тема, длинный русский текст |
| Администрирование | Обычный пользователь отказывает по согласованному 404/403, ADMIN работает; debug ограничен | API + browser; fail-closed отсутствие служебных секретов |

## Критерии закрытия и evidence

- [ ] В каждом issue ссылка на конкретный regression test и новый результат, а не только скриншот кода.
- [ ] Для #31/#32 сохранены root typecheck/lint/unit/component результаты; интеграционные skips перечислены отдельно.
- [ ] На изолированной `_test` среде пройдены обязательные DB/Socket/browser сценарии; проверены V2/legacy, роли и reconnect. Если сценарий не выполнен — issue остается открытым либо явно ограничивается его scope.
- [ ] HTTP smoke повторен после изменений и сверены бизнес-данные; намеренные статусы отказа согласованы. Страница 200 не засчитывается вместо browser acceptance.
- [ ] Evidence содержит revision/snapshot, команды, окружение без секретов, test counts, скриншоты/trace только для релевантных browser сценариев. Игнорируемые `.log` приложены явно либо экспортированы в публикуемый формат.
- [ ] Не закрывать весь аудит из-за зеленого subset: итог показывает PASS/FAIL/BLOCKED/NOT RUN по матрице и оставшиеся риски. Изменения схемы/storage имеют проверенный rollback на тестовой среде до production.


## Уточнение после живой сверки координатора

API smoke завершён: 30 проверок ожиданий, 30 PASS. В это число входят три ожидаемых 404 отсутствующих страниц/upload. Admin endpoint обычному USER намеренно возвращает404; начальное ожидание403 было ошибкой smoke и исправлено после чтения контракта и повторного запроса. Подробности: [LIVE_VALIDATION.md](LIVE_VALIDATION.md). Дополнительные UX-задачи: #49 selection, #50 a11y/mobile, #51 priority/Inbox, #52 admin pagination; см. [BACKLOG.md](BACKLOG.md).
