# ЛЕНКАНБАН API: контракт текущих исходников

Сверено 20.10.2026 с `src/app/api/**/route.ts`. Базовый путь — `/api`; локальный адрес зависит от запуска (для изолированного E2E — `http://127.0.0.1:3555/api`). Доступность и версия удалённого сервера этой сверкой не подтверждаются.

## Аутентификация и доступ

`requireApiUser` принимает cookie NextAuth или `Authorization: Bearer <api-token>`. API-токен — случайный opaque token формата `kb2_<prefix>_<secret>`, а не JWT; в БД хранится SHA-256. Отозванный/невалидный Bearer не даёт fallback на cookie. Маршруты с `requireDbUser` и прямым `getServerSession` требуют браузерную сессию. Создание и отзыв токенов доступны только с сессией; сам токен возвращается при создании.

Матрица ниже фиксирует механизм, найденный в файле, и не заменяет проверки прав каждого обработчика. Общий `project-access.ts` разрешает запись владельцу, участникам и глобальному ADMIN; управление участниками — владельцу, PROJECT_ADMIN и ADMIN. Некоторые отказы возвращают 404, скрывая существование ресурса.

`POST /api/auth-login` проверяет формат и rate limit, но не пароль и не создаёт сессию; отвечает `{ "ok": true }`. Реальный вход выполняет NextAuth. `POST /api/auth/login` намеренно не используется и возвращает `{ "ok": false }`.

## Ответы и лимиты

Большинство маршрутов использует `apiSuccess`: `{ "success": true, "data": ..., "meta": ... }`; ошибки — `{ "success": false, "error": { "code": "...", "message": "...", "details": ... } }`. Это не универсальный формат: preflight, NextAuth, диагностический endpoint и `rateLimitErrorResponse` имеют собственные ответы. Общие коды: 400 (JSON/запрос), 401, 403, 404, 409, 422 (Zod) и 500. Клиенту нужно проверять HTTP status и тело конкретного маршрута.

В `src/lib/rate-limit.ts` правила задаются по операции, а не для всех GET/POST: регистрация 10/мин на IP, login preflight 20/мин, forgot/reset 5/мин, создание токена 10/мин; задачи create 60/update 120/delete 30/bulk 20 в минуту на ключ пользователя. Проверять, вызывает ли маршрут limiter: само наличие правила не включает защиту. Часть обработчиков допускает fail-open при ошибке limiter. Ответ 429 из `rateLimitErrorResponse`: `{ "error": "RateLimited", "retryAfter": N }` и `Retry-After`.

## Основные контракты

- `GET /api/tasks`: параметры `projectId`, `search`, `assignedToMe=true`, `status`, `columnId`, `page`, `limit`. Без явного limit выборка не ограничена; с limit используется page, верхняя граница 100. Поиск ограничивается 10 результатами. Ранее описанные серверные `priority`, `assigneeId`, `sortBy`, `offset` в этом обработчике не читаются.
- `POST /api/tasks` создаёт одну задачу. `PATCH /api/tasks/bulk` изменяет существующие задачи; `POST /api/tasks/bulk-update` — отдельный session-only путь массового изменения. Это не массовое создание.
- `POST /api/tasks/{id}/move` принимает строгий объект `toColumnId`, `beforeTaskId` и `afterTaskId` (оба допускают null), UUID `operationId`, целое `expectedVersion >= 0`. Ответ включает operationId, boardRevision, task с id/columnId/version/status. Конфликт версии и повтор operationId с другим содержимым — 409; неверная колонка/соседи — 422. Статус выводится из workflow колонки, `REVIEW` соответствует `IN_REVIEW`.
- `PATCH /api/tasks/{id}/attachments` принимает JSON-массив metadata вложений в поле `attachments` (url, name, size, mime, необязательные width/height). Файловых маршрутов `/api/uploads/direct` и `/api/uploads/presign` в текущем дереве нет; старые инструкции о multipart-загрузке и лимите 50 МБ не описывают этот checkout.
- Подтверждение почты — **GET** `/api/auth/verify-email?token=…`, изменяющий состояние. Потоки регистрации/восстановления — [EMAIL_WORKING.md](../EMAIL_WORKING.md).
- Уведомления и их pagination — [NOTIFICATIONS_DEPLOYMENT.md](../NOTIFICATIONS_DEPLOYMENT.md). Для `/api/activities`, сообщений, saved views, recurring tasks, templates и automation точные поля валидируются в соответствующем route; они не унифицированы общей схемой.

## Инвентаризация маршрутов

Все строки ниже получены из экспортов текущих route-файлов; наличие маршрута не означает его пригодность как публичного API.

| Путь | Методы | Найденная аутентификация |
|---|---|---|

| `/api/activities` | GET | cookie / API Bearer |
| `/api/admin/me` | GET | cookie / API Bearer |
| `/api/admin/projects` | GET | cookie / API Bearer |
| `/api/admin/users/{id}` | PATCH | cookie / API Bearer |
| `/api/admin/users` | GET | cookie / API Bearer |
| `/api/analytics` | GET | cookie / API Bearer |
| `/api/auth-login` | POST | публичный auth / NextAuth |
| `/api/auth/{...nextauth}` | GET, POST | публичный auth / NextAuth |
| `/api/auth/forgot-password` | POST | публичный auth / NextAuth |
| `/api/auth/login` | POST | публичный auth / NextAuth |
| `/api/auth/register` | POST | публичный auth / NextAuth |
| `/api/auth/resend-verification` | POST | публичный auth / NextAuth |
| `/api/auth/reset-password` | POST | публичный auth / NextAuth |
| `/api/auth/verify-email` | GET | публичный auth / NextAuth |
| `/api/automation-rules/{id}` | GET, PATCH, DELETE | cookie / API Bearer |
| `/api/automation-rules` | GET, POST | cookie / API Bearer |
| `/api/messages/unread` | GET | session cookie |
| `/api/notifications/{id}` | PATCH | cookie / API Bearer |
| `/api/notifications/mark-all-read` | PATCH | cookie / API Bearer |
| `/api/notifications` | GET | cookie / API Bearer |
| `/api/notifications/unread-count` | GET | cookie / API Bearer |
| `/api/project-templates/{id}` | DELETE | cookie / API Bearer |
| `/api/project-templates/{id}/use` | POST | cookie / API Bearer |
| `/api/project-templates` | GET, POST | cookie / API Bearer |
| `/api/projects/{id}/columns/{columnId}` | PATCH, DELETE | cookie / API Bearer |
| `/api/projects/{id}/columns/reorder` | PATCH | cookie / API Bearer |
| `/api/projects/{id}/columns` | GET, POST | cookie / API Bearer |
| `/api/projects/{id}/members/{memberId}` | PATCH, DELETE | cookie / API Bearer |
| `/api/projects/{id}/members` | GET, POST | cookie / API Bearer |
| `/api/projects/{id}` | GET, PATCH, DELETE | cookie / API Bearer |
| `/api/projects` | GET, POST | cookie / API Bearer |
| `/api/recurring-tasks/{id}` | GET, PATCH, DELETE | cookie / API Bearer |
| `/api/recurring-tasks/process` | POST | CRON_SECRET, если задан |
| `/api/recurring-tasks` | GET, POST | cookie / API Bearer |
| `/api/saved-views/{id}` | GET, PATCH, DELETE | session cookie |
| `/api/saved-views` | GET, POST | session cookie |
| `/api/tags/{id}` | PATCH, DELETE | cookie / API Bearer |
| `/api/tags` | GET, POST | cookie / API Bearer |
| `/api/tasks/{id}/assignees` | PUT | cookie / API Bearer |
| `/api/tasks/{id}/attachments` | PATCH | cookie / API Bearer |
| `/api/tasks/{id}/checklist/{itemId}` | PATCH, DELETE | cookie / API Bearer |
| `/api/tasks/{id}/checklist` | GET, POST | cookie / API Bearer |
| `/api/tasks/{id}/comments` | GET, POST | публичный ответ 410 COMMENTS_DEPRECATED; использовать messages |
| `/api/tasks/{id}/messages/read` | POST | session cookie |
| `/api/tasks/{id}/messages` | GET, POST | cookie / API Bearer |
| `/api/tasks/{id}/move` | POST | session cookie |
| `/api/tasks/{id}` | GET, PATCH, DELETE | cookie / API Bearer |
| `/api/tasks/{id}/tags` | PUT | cookie / API Bearer |
| `/api/tasks/bulk-update` | POST | session cookie |
| `/api/tasks/bulk` | PATCH | cookie / API Bearer |
| `/api/tasks` | GET, POST | cookie / API Bearer |
| `/api/templates/{id}` | GET, PATCH, DELETE | cookie / API Bearer |
| `/api/templates/{id}/use` | POST | cookie / API Bearer |
| `/api/templates` | GET, POST | cookie / API Bearer |
| `/api/test-socket-emit` | GET | явный auth guard не найден в route |
| `/api/tokens/{id}` | DELETE | session cookie |
| `/api/tokens` | GET, POST | session cookie |
| `/api/user/profile` | PATCH | cookie / API Bearer |
| `/api/users` | GET | cookie / API Bearer |

## Socket.IO и полнота спецификации

Socket.IO — отдельный протокол, не REST: сервер проверяет NextAuth-сессию через cookie и права доступа к задаче. API Bearer не заменяет Socket.IO session cookie. Источники: `src/socket/server.ts`, `src/socket/board-events.ts` и chat feature modules.

[openapi.yaml](../openapi.yaml) — частичная историческая спецификация. В ней исправлены общие сведения об auth/полноте, но все paths и schemas не пересверены: для генерации клиента требуется отдельная синхронизация с маршрутами и контрактные тесты. Текущая матрица точнее для методов и наличия маршрутов. Документальная сверка не выполняла HTTP-запросы, тесты с БД и проверку прав на удалённом стенде.

