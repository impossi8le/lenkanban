# Скорость API и подключение realtime — 26.10.2026

## Запрос и договорённость о кеше

Пользователь указал на pending `projects`, `unread` и WebSocket, попросил максимально ускорить интерфейс и предложил общую готовую основу с персональными дополнениями. Общие публичные названия, формы и оформление уже отдаются статическим каркасом — см. [INSTANT_HOME](INSTANT_HOME_2026-10-26.md).

Закрытые данные нельзя делить только по globalRole: отдел, группа исполнителей, авторство, назначение, наблюдение и отдельные привилегии меняют видимость внутри одной роли. В текущей реализации navigation/unread query keys содержат actor ID. Кеш UI может немедленно показать ранее полученные данные своего сотрудника, затем обновиться; сервер заново проверяет права. События и мутации инвалидируют нужные ключи, revocation уничтожает защищённое состояние. Новый общий серверный кеш приватных заявок/счётчиков по роли не вводится. Будущий серверный кеш требует версии прав, полной инвалидации и отрицательных тестов; увеличение TTL само по себе не заменяет проверку доступа.

## Реализация

Application source `072329975185c35726a1110a0e33df2e7ea80ce9`, tree `837390dbf8ab995f5184e97b6ecf7f79cb2d78ac`. Freeze 12 файлов: `work/api-latency-20261026/source-freeze.json`.

- `GET /api/projects?view=navigation` возвращает только `id,name` с прежними auth/projectReadPredicate/search. Нет owner, подсчётов задач и getTaskReadWhere. Pagination в этом режиме отклоняется 400; legacy/page остаются совместимыми.
- Desktop/mobile DepartmentNavigation используют один actor-scoped ключ `['projects','navigation',actorId]` и общий reference TTL 5 минут. Полный список для страницы проектов больше не нужен меню. `['projects']` mutation invalidation охватывает оба варианта. Fetch получает AbortSignal.
- В legacy/page owner теперь выбран явно: id/name/email/avatarUrl/globalRole. Пароли и token-поля владельца не сериализуются. Синтетические секреты проверены в JSON regression tests; реальные секреты не читались и не помещались в отчёт.
- Unread группируется PostgreSQL через Prisma groupBy(taskId,readBy) с прежними task ACL/isInternal:false. JS сохраняет falsey-семантику прочтения. Только непрочитанные task IDs дополнительно разрешаются через тот же ACL; удалённые/скрытые mappings не входят в итог. Новых raw SQL predicates, схемы, глобального кеша или формата логов нет.
- Слушатели desktop/mobile coalesce unread invalidation в одной microtask на actor/query client. Одно событие больше не перезапускает один и тот же fetch дважды. Новые события по-прежнему вызывают обновление, отменённые запросы получают AbortSignal.
- Realtime начинает с HTTP polling и затем фоном переходит на WebSocket. Это [стандартный порядок Socket.IO](https://socket.io/docs/v4/client-options/#transports); блокировка Upgrade не останавливает первоначальный join и доставку. Два независимых socket channels не объединялись: их lifecycle и права сохранены.

## Проверки

CI `40293490715` success: **7562 passed / 148 skipped**, 434 files passed / 26 skipped; TypeScript и ESLint success. Необязательные PostgreSQL/E2E/visual jobs skipped. Linux archives `40293490637` success, production BUILD_ID `build-1793003898218`.

Локальные focused API/component проверки: 64 tests passed; socket/revocation/notification-hook/unread — 21 passed (наборы частично пересекаются, не суммировать). Nonincremental TypeScript и target ESLint прошли.

### Реальный PostgreSQL benchmark, только отдельная QA БД

`work/api-latency-20261026/unread-benchmark.ts`: жёстко требует `lenkanban_prodqa_20261026_test`, настоящие actor/ACL и Prisma engine. В RepeatableRead transaction добавляет 10 000 синтетических public сообщений с семью вариантами readBy (включая null/false/0/empty string), сравнивает старый и новый алгоритмы три раза, затем намеренно rollback. Число сообщений после теста совпало с исходным. Production БД не менялась.

| Показатель | Прежний алгоритм | Новый |
| --- | ---: | ---: |
| Полученные строки/группы | 10 005 | 12 |
| JSON transfer projection, bytes | 1 160 897 | 1 614 |
| Медиана DB + JS обработки, ms | 118,99 | 34,71 |

Counts идентичны. Это синтетический тест, не замер production API/UI. Выигрыш зависит от повторяемости readBy; при уникальных receipt JSON сокращение групп будет меньше. Дополнительный ACL mapping query входит в новый замер.

### Настоящий UI с принудительным отказом WebSocket

IAB: автор `localhost:3869`, исполнитель `127.0.0.1:3866`; source `0723299` собран отдельно с легитимными QA runtime origins, не byte-identical production archive. BUILD_ID `build-1793003864370`; DB/private configuration/attachments сохранены.

Только на QA proxy временно запрещены HTTP Upgrade (403), обычные HTTP polling/auth работают. Автор через форму создал `QA SPEED 006 — доставка через HTTP` (task `cmvp0ebfo0001pt01rcyo8kqr`). Без reload исполнитель увидел «Новые 1», кнопку «Взять в работу» и новое уведомление в колокольчике. Клик по уведомлению открыл карточку; взятие в работу перевело её в «В работе», автор без reload увидел QA executor.

Снимок `work/api-latency-20261026/evidence/http-only-new-and-bell.jpg`. Proxy log агрегат содержит четыре Upgrade 403 и polling 200; raw queries/session IDs не выводились. Выборка также включает startup 502/ранние 101 до fault injection, поэтому не объявляется полностью безошибочным сетевым интервалом. Оригинальный QA nginx.conf восстановлен byte-for-byte, SHA256 `54b3d3a09da1dd76f9558bf840453591289ffeca89eaee326d818ff4376e8a7b`, nginx -t/reload успешны.

Системное OS Notification не подтверждено (IAB permission prompt недоступен). Авторизованный production UI по-прежнему ограничен инструментом; обходов через Chrome/cookies/API не было.

## Диагностика production до выкладки

Read-only SSH: 2 проекта / 8 задач / 3 сообщения, app около 182 MiB, socket 43 MiB, DB 260 MiB; в момент выборки CPU 0%. Публичные HTTPS проверки с VPS 0,061 s / 0,047 s и HTTP/2. Это не замер авторизованных endpoints. С компьютера один публичный WebSocket probe завершился ошибкой, следующий получил HTTP Upgrade и Engine.IO handshake за 692/693 ms; авторизации и namespace join probe не выполнял. По pending скриншоту нельзя установить конкретную стадию задержки.

## Выкладка

Артефакты и guards: `work/redesign-implementation-20261025/api-latency-REVIEW.md`. **Активировано 26.10.2026 около 11:53 МСК**: fresh backup/activation/postchecks PASS, оба сервиса healthy, restarts=0/OOM=false, прежняя БД. Фактические runtime identities и backup в [production отчёте](../../deploy/API_LATENCY_PRODUCTION_2026-10-26.md). User/password/role mutations в release отсутствуют. Независимые локальные изменения members route и ProjectMembersDialog не входят в source freeze, не перезаписывались и не импортировались в baseline.

После выкладки отдельный public WebSocket probe с компьютера не установился примерно за 10,677 s, следующий — успешно прошёл Upgrade/Engine.IO handshake за 482/483 ms. Это остаётся диагностическим ограничением: стабильность прямого WS и причина сетевого сбоя не подтверждены. HTTP fallback проверен на QA, не заявляется исправлением сетевого маршрута.
