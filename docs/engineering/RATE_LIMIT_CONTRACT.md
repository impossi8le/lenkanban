# Ограничение частоты: фактический срез #96

23.10.2026. Общий механизм — `src/lib/rate-limit.ts`: атомарный PostgreSQL conditional upsert. Отклонённые попытки не увеличивают счётчик; после истечения окна первое допущенное обращение считается как 1. Отказ возвращает консервативный Retry-After, равный целому окну (60 секунд для перечисленных правил). SQL/схема этим срезом не менялись.

## Вход

Credentials authorize уже использует `auth:login`: **20/минуту по IP и отдельно 20/минуту по хэшу нормализованного email**, до чтения аккаунта/проверки пароля. Отказ/неисправность лимитера закрывает вход. NextAuth возвращает обычный отказ авторизации (не обещается HTTP 429 именно от credentials callback). Шесть ошибочных входов ниже порога и не доказывают отсутствия ограничения. Постоянная блокировка аккаунта этим механизмом не вводится.

24.10.2026, решение root в рамках #96: `POST /api/auth-login` получает **отдельный preflight IP-бюджет 20/мин**, ключ `auth:login:preflight:<effective IP>`. Порог и SQL общего `auth:login` не меняются; используется тот же configured rule с отдельным suffix. Реальная проверка credentials сохраняет собственные `auth:login:<effective IP>` и `auth:login:email:<hash>` по 20/мин. При пустых окнах и одном effective IP двадцать полных submit формы расходуют по одному admission в каждом из трёх соответствующих бюджетов; preflight больше не съедает второй admission реального IP-входа. 21-й preflight в окне возвращает 429/Retry-After:60. Preflight не проверяет существование аккаунта и не заменяет fail-closed authorize. Прямой callback остаётся ограниченным независимо от вызова preflight; его generic401 и неразличимость unknown/wrong/blocked аккаунтов сохраняются.

IP поступает из заголовков на доверенной proxy-границе. Публичный nginx template теперь **перезаписывает** X-Forwarded-For адресом `$remote_addr`, как и X-Real-IP; клиентский префикс цепочки не сохраняется. Это важно, поскольку existing helper использует первый XFF. Настройка предполагает nginx публичным edge и закрытые прямые upstream-порты. Если перед nginx есть ещё один proxy/CDN, нужна отдельно проверенная trusted real-IP конфигурация; нельзя автоматически доверять любому forwarded заголовку. Шаблон не доказывает состояние работающего production nginx.

## Чтение заявок

`GET /api/tasks` теперь вызывает `tasks:list` **120/минуту на аутентифицированного пользователя** до policy lookup и task/aggregation queries. Все доски, поиски, страницы, cookie/bearer и роли этого пользователя делят одно окно; клиентский user/IP/search не формирует ключ. Администратор не получает обхода. 120/минуту соответствует существующему порядку частоты tasks:update (2 обращения в секунду в среднем) и допускает обычную короткую серию чтений; порог не подбирался ради воспроизведения 429 на 30 запросах.

Исчерпание → HTTP 429 с `Retry-After: 60` и существующим `{error:"RateLimited",retryAfter:60}`. Неисправность limiter/database → безопасный existing 500 до доступа к данным, без обхода лимита. Неаутентифицированный запрос → 401 до расходования actor quota. Поисковые строки, IP/email и ошибки БД не добавляются в логи.

## Уже определённые квоты

В existing DEFAULTS также определены (в минуту): register 10/IP; forgot/reset-password по 5/IP; token create 10/IP; tasks create 60, update 120, delete 30, bulk 20 на actor; projects create 10/update 30/delete 10; upload presign 30; messages send 60; notifications create 100; telemetry actor 60/global 600. Само определение правила не доказывает вызов во всех маршрутах: этот срез не является аудитом/защитой всех API.

## Доказательства и границы

Target route tests используют настоящий общий limiter с mocked `$queryRaw`, проверяют 120 допущенных чтений, 121-й отказ, изоляцию actor и отсутствие task query при отказе. Payload/workflow/access tests изолируют admission отдельной подменой, сохраняя свои assertions. Existing authorize и mutation admission tests проверены. Ранее в этой волне **91 real PostgreSQL integration test** прошёл в отдельном tmpfs-контейнере, включая atomic admission/реальную очередь блокировок; поскольку SQL не менялся, повтор полного PG набора для добавления правила не проводился.

Реальная работа доски с несколькими вкладками, reconnect/поиском и настройка production proxy остаются приёмочными сценариями. Unit-последовательность 120 чтений не заменяет browser acceptance. Другие list/detail/API channels, общий DDoS perimeter и постоянные account lockout policies этим срезом не заявляются реализованными.

## Дополнение 24.10.2026: два core mutation маршрута

Проверка веток подтвердила: canonical `PATCH /api/tasks/:id` с operationId/changes и lifecycle `POST /api/tasks/:id` уже вызывают `tasks:update`, а `DELETE /api/tasks/:id` — `tasks:delete` до разделения logical/physical. Эти существующие ветки не менялись.

Закрыты две конкретные дыры admission: `POST /api/tasks/:id/move` теперь использует существующий `tasks:update` **120/мин на actor**, общий со scalar/lifecycle/legacy PATCH; `PATCH /api/tasks/bulk` использует существующий `tasks:bulk` **20/мин на actor**, общий с `POST /api/tasks/bulk-update`. Нового tasks:move правила, изменения DEFAULTS/SQL/схемы или повторного service-level списания нет. В bulk списывается один admission на запрос, не на задачу.

Admission выполняется после авторизации и синтаксически допустимого payload, до первого task/policy query, repository/receipt lookup и транзакции. Повтор operationId или тот же batch также расходует admission; ACL/marker/version/receipt и existing postcommit-механизм остаются обязательными. ADMIN не получает обхода, ключ строится из authenticated actor.id, cookie и bearer не формируют отдельные бюджеты. Отказ общего limiter со status429 возвращает существующий RateLimited/Retry-After; неисправность хранилища возвращает безопасный500 без доступа к task/repository/mutation/effects.

Прямые route-тесты используют настоящий общий limiter с synthetic atomic SQL adapter: общий120-й/121-й update admission, смешанные PATCH/POST bulk20/21, изоляция actor, роли USER/ADMIN, неавторизованный/заблокированный отказ без quota, сохранение validation422, повторное admission до receipt dispatch, safe500/429 до данных и effects. Отдельные business fixtures явно подменяют admission, сохраняя прежние lock/receipt/rollback/automation assertions. Это unit-проверки с моками; они не называются actual PostgreSQL или browser-приёмкой. Изменение не утверждает защиту всех API; прочие найденные особенности вне этих двух маршрутов остаются отдельным scope.
