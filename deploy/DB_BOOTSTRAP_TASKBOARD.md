# Установка схемы taskboard на пустой БД (сервер)

Документ — точный порядок для человека с доступом к VPS. Все команды выполняются
из `/opt/taskboard` в compose-проекте `taskboard`. Секретов здесь нет: пароли
берутся из `.env.taskboard` (права `600 root:root`).

Проверено локально на изолированном PostgreSQL 16: цепочка применена дважды
с нуля, схема совпала с `prisma/schema.prisma`, все CHECK-ограничения,
частичные и GIN-индексы созданы. На реальном VPS не выполнялось.

## 1. Что изменилось в истории миграций

Историческая цепочка была неполной: первая миграция `20260317000000_add_tags_system`
создавала `Tag` со ссылкой на `Project`, но миграции, создающей `Project`, не было.
На пустой БД `prisma migrate deploy` падал на первом шаге. Кроме того, часть объектов
не выражается в `schema.prisma` (CHECK-ограничения, частичные индексы, GIN/trigram,
collation `C` для `Task.rank`), поэтому `db push` их молча терял.

Сейчас история свёрнута в одну baseline-миграцию
`prisma/migrations/20260101000000_baseline/`, которая создаёт полную текущую схему.
`prisma/migrations_legacy/` — архив, в `migrate deploy` не участвует.
`prisma/migrations/migration_lock.toml` фиксирует провайдер `postgresql`.

## 2. Предусловия

```sh
cd /opt/taskboard

# .env.taskboard заполнен: POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB,
# TASKBOARD_VERSION, NEXTAUTH_* и остальные обязательные значения.
sudo stat -c '%a %U:%G %n' .env.taskboard        # ожидается 600 root:root

# Compose подставляет ${POSTGRES_*}, ${TASKBOARD_VERSION}, ${NEXT_PUBLIC_APP_URL}
# из env-файла, а не из service env_file.
export COMPOSE_ENV_FILES=.env.taskboard           # Compose >= 2.24
# Для старого Compose добавляйте к каждой команде: --env-file .env.taskboard

docker compose -f compose.taskboard.yaml -p taskboard config --quiet \
  && echo "compose OK"

# Образ migrate должен быть собран (при полной установке его собирает
# `--profile tools build app socket migrate`).
docker compose -f compose.taskboard.yaml -p taskboard --profile tools build migrate
```

Baseline выполняет `CREATE EXTENSION IF NOT EXISTS pg_trgm`. В PostgreSQL 13+
`pg_trgm` — trusted extension, поэтому владелец БД может создать её сам.
Если на сервере политика это запрещает, DBA заранее выполняет
`CREATE EXTENSION pg_trgm` в этой БД от суперпользователя; иначе baseline
остановится на первом шаге.

## 3. Создание БД и пользователя

При **пустом** томе `taskboard_pgdata` официальный образ `postgres` сам создаёт
роль `POSTGRES_USER` и БД `POSTGRES_DB` при первом старте. Отдельные `CREATE USER`
и `CREATE DATABASE` не нужны.

```sh
docker compose -f compose.taskboard.yaml -p taskboard up -d db

# дождаться healthy (не начинать миграции до этого)
docker compose -f compose.taskboard.yaml -p taskboard ps db
```

Проверка, что роль и БД существуют (подключение к рабочей БД):

```sh
docker compose -f compose.taskboard.yaml -p taskboard exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT current_database(), current_user"'
```

Ожидается строка `taskboard|taskboard` (значения из `.env.taskboard`).

Если том уже существует, а БД удалена вручную, создать её отдельно:

```sh
docker compose -f compose.taskboard.yaml -p taskboard exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
     -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\""'
```

Пароль роли задаётся только при инициализации тома. Если `POSTGRES_PASSWORD`
в `.env.taskboard` меняли после первого старта, сменить пароль в БД. Пароль
читается из окружения контейнера через `psql \getenv`, а не подставляется в
командную строку:

```sh
docker compose -f compose.taskboard.yaml -p taskboard exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1' <<'SQL'
\getenv dbuser POSTGRES_USER
\getenv dbpass POSTGRES_PASSWORD
ALTER ROLE :"dbuser" WITH PASSWORD :'dbpass';
SQL
```

## 4. Применение миграций

```sh
docker compose -f compose.taskboard.yaml -p taskboard \
  --profile tools run --rm migrate
```

Сервис `migrate` — одноразовый контейнер из стадии `builder` (там есть Prisma CLI
и каталог `prisma/`). Он выполняет `npx prisma migrate deploy` против БД `db`.

Ожидаемый вывод:

```
1 migration found in prisma/migrations
Applying migration `20260101000000_baseline`
All migrations have been successfully applied.
```

Повторный запуск идемпотентен:

```
No pending migrations to apply.
```

## 5. Проверка результата

### 5.1 Статус миграций

```sh
docker compose -f compose.taskboard.yaml -p taskboard \
  --profile tools run --rm migrate npx prisma migrate status
```

Ожидается: `Database schema is up to date!`

### 5.2 Схема совпадает с `schema.prisma`

```sh
docker compose -f compose.taskboard.yaml -p taskboard \
  --profile tools run --rm --entrypoint sh migrate -c \
  'npx prisma migrate diff --from-url "$DATABASE_URL" \
     --to-schema-datamodel prisma/schema.prisma --script'
```

Успех — ровно:

```
-- This is an empty migration.
```

Любой непустой SQL означает расхождение: не запускать приложение, разбираться.

### 5.3 CHECK-ограничения, индексы, extension, collation

```sh
docker compose -f compose.taskboard.yaml -p taskboard exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < deploy/sql/verify_taskboard_schema.sql
```

Ожидается `NOTICE: schema verification OK` и:

| metric | value |
| --- | --- |
| tables | 39 |
| public CHECK constraints | 3 |
| custom indexes | 7 |

Скрипт read-only; при отсутствии любого объекта завершается ошибкой.

### 5.4 Порты и здоровье

```sh
# Если образы app/socket ещё не собраны:
# docker compose -f compose.taskboard.yaml -p taskboard --profile tools build app socket migrate
docker compose -f compose.taskboard.yaml -p taskboard up -d app socket
docker compose -f compose.taskboard.yaml -p taskboard ps

APP_PORT="${TASKBOARD_APP_PORT:-18766}"
SOCKET_PORT="${TASKBOARD_SOCKET_PORT:-18767}"
curl -sS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$APP_PORT/api/auth/session"
curl -sS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$SOCKET_PORT/socket.io/?EIO=4&transport=polling"
ss -lntp | grep -E ":($APP_PORT|$SOCKET_PORT)\b"
```

Оба ответа `200`; порты слушают только `127.0.0.1`. Если 18767 занят, поменять
`TASKBOARD_SOCKET_PORT` в `.env.taskboard`, перезапустить `socket` и заново
отрендерить nginx-шаблон (см. `deploy/nginx/taskboard.conf.template`).

## 6. Откат и повторная проверка

Baseline — свёрнутый снимок всей схемы. Его откат удаляет схему `public` целиком,
включая `_prisma_migrations`, то есть **все данные**:

```sh
docker compose -f compose.taskboard.yaml -p taskboard exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < prisma/migrations/20260101000000_baseline/ROLLBACK.sql
```

Применять только к одноразовой/тестовой БД. На рабочей БД откат схемы — только
восстановление из бэкапа с согласия владельца.

## 7. Чего не делать

- Не выполнять `prisma db push`, `prisma db reset`, `npm run db:reset` на рабочей БД.
- Не выполнять `prisma migrate dev` на сервере: он может удалить объекты, которые
  не выражаются в `schema.prisma` (частичный индекс, collation).
- Не править baseline после первой установки на сервере: изменения схемы — только
  новой миграцией.
- Не удалять том `taskboard_pgdata` и не выполнять `docker compose down -v`.

## 8. Если baseline уже применялся старой версией

Baseline был исправлен до первой установки на сервере (добавлены GIN-индексы,
частичный индекс, collation, `migration_lock.toml`). Если baseline успели применить
на одноразовой БД старой версией, `migrate deploy` сообщит об изменённой миграции.
Для одноразовой БД проще пересоздать её и применить цепочку заново. Для БД с данными
не редактировать `_prisma_migrations` вручную: сверить схему и согласовать решение
с владельцем.

## 9. Ограничения проверки

- Прогон выполнен на локальном контейнере `postgres:16`, не на VPS.
- Реальный сервер, nginx, TLS и certbot не проверялись.
- Проверка не заменяет приёмочные действия #70 на сервере.
