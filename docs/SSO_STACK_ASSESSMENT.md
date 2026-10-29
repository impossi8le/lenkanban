# Стек корпоративного входа и границы интеграции

Обновлено 20.10.2026. Основание: [предоставленный перечень](reference/TECH_STACK_PROVIDED_2026-10-20.md) и ранее просмотренные публичные клиентский JS basav2/HTML login-app. Серверный исходный код и production-конфигурация не получены. Версии в таблице заявлены в перечне, а не измерены на сервере.

## Что относится к нашему запросу

| Компонент | Предоставленный стек | Практический запрос подрядчику |
| --- | --- | --- |
| login-app | PHP 8.2, Laravel 12.53, firebase/php-jwt 7.0, Guzzle 7.10, MySQL, Redis phpredis, Docker php:8.2-fpm-alpine | Документировать вход/refresh/logout, способ проверки JWT или opaque exchange, реальный источник пользователей, зависимости и запуск test-копии |
| basa-backend | PHP 8.1, Laravel 9.52, Sanctum 3.3, Redis predis, MySQL, l5-swagger 8.6 | Передать только модуль приёма SSO, guard/middleware, профиль и схему связи пользователей, если это часть нужного обмена |
| frontend-mono | React 18.2, TypeScript 5.4, Vite 5.2, RTK Query, codegen OpenAPI, async-mutex 0.4 | Фрагмент auth/baseQuery/refresh, версия OpenAPI и конфигурация публичных URL; не весь монорепозиторий |
| Legacy basa/point | PHP 7.4+, JWT, MySQL; Redis для point, Memcached для basa | Проверить, не является ли legacy БД/сервис источником идентичности. Включать в стенд только при подтверждённой зависимости |
| Phoner и остальные API | Разные версии Laravel/Sanctum/JWT, софтфон JsSIP/XState | Уточнить назначение phone/point. SSO не подразумевает подключение телефонии, платежей, CDR и всего CRM |
| Наш Ленканбан | Next.js 15, React 19, NextAuth 4, Prisma/PostgreSQL, Socket.IO | Реализовать адаптер к согласованному контракту, локальную привязку личности и собственные права. MySQL SSO не заменяет PostgreSQL Ленканбана |

## Что наблюдалось в интерфейсе и клиентском коде

- Basav2 обращается к login-app, поддерживает /api/sso/login с uid/token/phone/point и центральный /api/auth/refresh-from-cookie.
- API-запросы используют cookies через credentials include; при401 реализованы refresh, повтор и redirect на вход. Форма login-app содержит login/password, офис и phone.
- Это подтверждает клиентскую схему, но не показывает алгоритм подписи, серверные guards, TTL, cookie flags, хранилище сессий или каталог сотрудников.

## Какие реализации могли быть использованы

| Вариант | Почему его стоит проверить | Что докажет применение |
| --- | --- | --- |
| Собственный SSO с JWT и созданием локальной сессии | Согласуется с обменом uid/token и заявленной php-jwt | Код выпуска/проверки ответа, claims/alg/keys/TTL/replay, маршруты и документированный flow |
| Laravel cookie/session и Sanctum SPA guard в basav2 | Cookies наблюдались, Sanctum заявлен у basa-backend | Guard и middleware маршрутов, stateful domains, CSRF flow, cookie/session config |
| Bearer personal access token Sanctum | Пакет допускает API-токены, но это не наблюдение включённого режима | Контракт выдачи/проверки/revoke, abilities/TTL и header; не переносить рабочие токены |
| OIDC/SAML или адаптер поверх другого IdP | Может существовать в собственной реализации или внешнем сервисе | Подтверждение подрядчика, metadata/issuer, endpoints, регистрация клиента и серверная проверка |
| LDAP/AD за login-app | Возможный внешний источник пользователей | Подтверждённый provider/connector, схема ID/групп/блокировки; один стек PHP это не доказывает |

JWT-библиотека не равна OIDC. Sanctum поддерживает и cookie-сессии SPA, и API-токены; он не является доказательством отдельного SSO-протокола. Redis может обслуживать cache/session/queue/revocation, но его фактическое назначение надо подтвердить. Наличие php-fpm не определяет используемый reverse proxy.

## Какие артефакты запросить под этот стек

1. login-app: composer.json/lock, Dockerfile и инструкция/compose, routes и контроллеры login/refresh/logout, middleware/guards/provider, сервис подписи/проверки ответа, публичная спецификация. Пути файлов должен указать владелец; config/jwt.php не считать обязательным для php-jwt.
2. Обезличенные config/auth.php, session.php, database.php, cache.php, CORS и bootstrap/middleware, .env.example с именами/назначением параметров. Не отдавать production .env или cached config с секретами.
3. basa-backend: только реализация /api/sso/login, profile/logout, config/sanctum.php и соответствующие guards/middleware, DTO/OpenAPI и mapping внешнего/локального user ID. Endpoint /api/sso/login наблюдался у basav2, а не доказан в login-app.
4. Frontend: auth/baseQuery/refresh под mutex, обработка 401/403 и redirect/logout; package/lock только нужного workspace и его auth-зависимости.
5. MySQL: фактическая версия, schema/migrations/seed, charset/collation/sql_mode/timezone, минимум связанных пользователей/групп/подразделений/офисов. Выяснить, общая ли это БД или разные подключения; не придумывать имена таблиц.
6. Redis: необходим ли стенду; роль, версия, namespace/DB/prefix, TTL и reset только тестового пространства. Новые тестовые сессии вместо дампа production Redis.
7. Отдельный APP_KEY и отдельные тестовые JWT secrets/keys. Если поля БД зашифрованы APP_KEY, подготовить синтетические данные/переинициализацию для нового test-ключа, не копировать production ключ.
8. Fixtures должны иметь искусственные ID и сохранённые внутри набора связи между login-app, legacy и потребителем, если такие связи реально нужны. Свежие test-пароли создаются seed-процедурой; production password hashes, sessions/tokens/PII не передаются.

## Границы и решение

Минимальная цель — один поддерживаемый вход Ленканбана плюс профиль и отзыв доступа. Не нужны вся CRM, frontend-mono целиком, ClickHouse/CDR, платежи или рабочие телефоны без подтверждённой зависимости. Если архив/код не предоставляется, допустим отдельный совместимый sandbox и документированный API.

Сначала спросить о текущем Laravel/JWT/cookie контракте и доступной test-копии. OIDC/SAML остаются условными альтернативами, а не требованием переделать провайдера. Права Ленканбана задаются его политикой, не прямым переносом Laravel guards или внешней роли admin.

## Источники технической интерпретации

[Laravel Sanctum](https://laravel.com/docs/12.x/sanctum): cookie SPA и API tokens — разные режимы. [Laravel authentication](https://laravel.com/docs/12.x/authentication): guards/providers. [php-jwt](https://github.com/firebase/php-jwt): библиотека JWT. Источники объясняют возможности технологий; не подтверждают настройку сервисов Ленремонта.
