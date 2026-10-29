# RUNBOOK #74: приёмка, согласованный backup, restore и репетиция отката

Для действующего production сначала сверить [PRODUCTION_STATE.md](PRODUCTION_STATE.md)
и [фактическую активацию 23.10](PRODUCTION_ACTIVATION_2026-10-23.md).
Этот исторический runbook не разрешает заменить рабочее окружение шаблоном,
восстановить удалённые QA-проекты или откатить логины/уведомления/телеметрию.

22.10.2026. Команды ниже — план для отдельно разрешённого операционного окна,
они **не выполнялись на VPS**. Выполнять в Bash с `set -euo pipefail; umask 077`.
Окно требует остановки записи; доступность на это время не обещается.
Секреты не выводить; не включать `set -x`. Использовать только проверенный release.

## 1. Предусловия и точная production-команда

```sh
cd /opt/taskboard
set -euo pipefail
umask 077
export COMPOSE_FILE=compose.taskboard.yaml COMPOSE_PROJECT_NAME=taskboard
export COMPOSE_ENV_FILES=.env.taskboard TASKBOARD_ENV_FILE=.env.taskboard
dc() { docker compose --env-file "$COMPOSE_ENV_FILES" -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" "$@"; }
dc config --quiet
dc --profile tools config --quiet
```

Проверить `TASKBOARD_VERSION` по `RELEASE_SNAPSHOT.json`, сохранить прежние image ID
и новый source hash. В production не применять validation fixture. Образы app/socket
и migrate собрать заранее из того же проверенного снимка на отдельном builder,
передать локально через `docker save/load` или разрешённый registry; сохранить image ID.
Команда запуска готовых production-образов (без пересборки):

```sh
dc up -d db
# Только после backup, проверки миграций и согласованного разрешения на их применение:
dc --profile tools run --rm --no-deps migrate
dc up -d --no-build app socket
dc ps
```

`npm start` из корня не является командой запуска standalone-образа: runner
использует сгенерированный `server.js`; socket — `dist/socket/server.js`.
Сеть/тома имеют префикс проекта, production сохраняет `taskboard_net`,
`taskboard_pgdata`, `taskboard_attachments`. Redis отсутствует и не требуется;
не подключать чужой cache. Внутренний HOSTNAME=0.0.0.0 нужен Docker bridge,
на хост публикуются только 127.0.0.1:18766 и 127.0.0.1:18767.

## 2. Приёмка и критерии остановки

```sh
dc ps --all
docker network inspect taskboard_net --format '{{json .Labels}}'
docker volume inspect taskboard_pgdata taskboard_attachments --format '{{.Name}} {{json .Labels}}'
dc port app 3000
dc port socket 3556
curl --fail --silent --show-error http://127.0.0.1:18766/api/auth/session -o /dev/null
curl --fail --silent --show-error 'http://127.0.0.1:18767/socket.io/?EIO=4&transport=polling' -o /dev/null
curl --fail --silent --show-error https://taskboard.lenremontn8n.ru/api/auth/session -o /dev/null
dc exec -T db sh -ec 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1"'
```

Проверить inspect контейнеров без вывода `.Config.Env`: Privileged=false,
NetworkMode не host, Mounts только проектные тома и tmpfs, нет docker.sock,
у db нет PortBindings; сеть не external. Не выводить полный inspect в отчёт.
Все долгоживущие сервисы должны быть healthy. Превышение лимитов/OOM, 5xx,
wildcard port, чужой mount или провал доступа — stop, запуск не принят.

В двух отдельных браузерных сессиях и на синтетической доске:

1. Вход и подтверждение email, выход и повторный вход; SMTP — только согласованный sink
   до проверки рабочих отправок. Проверка пароля не доказывает SSO.
2. Создание TaskRequest в DRAFT на поддерживаемой доске, reload, разрешённая отправка,
   повтор той же команды, конфликт двух исполнителей, уточнение с файлом,
   завершение и переоткрытие. Повтор не дублирует Activity/уведомления.
3. Загрузить синтетический файл, скачать и сравнить SHA256; запретить скачивание
   чужому пользователю и пользователю после отзыва доступа. Проверить лимиты/413,
   обычные и внутренние файлы/комментарии, прямой URL, историю и уведомления.
4. Во второй сессии проверить socket delivery/reconnect и отзыв доступа без утечек.
   Междосочный перенос должен отклоняться во всех затронутых каналах.
5. Перезапустить только `dc restart app socket`, повторить чтение заявки/файла.
   Проверить mobile, keyboard, light/dark. Healthcheck не заменяет эти сценарии.
6. Проверить Pino/Sentry synthetic secrets на границах, ADMIN-only диагностику,
   фактическое удаление старше 30 дней и scheduler. Не записывать body/cookies/тексты.

Фиксировать UTC, snapshot hash, image ID, миграции, статусы шагов, безопасные
идентификаторы и результаты. Не включать пользовательские данные в issue/логи.

## 3. Backup одной пары БД + файлы

Локальный storage обязателен для этого Compose. S3 требует отдельного согласованного
snapshot/versioning-процесса. Остановить app/socket и все внешние writers/cron
**до** дампа; миграции и orphans cleanup во время backup запрещены. До остановки
убедиться, что нет зависших загрузок. БД остаётся запущенной. Не возобновлять запись,
если один элемент пары не готов. Команды не используют бинарный stdout PowerShell.

```sh
BACKUP=/var/backups/taskboard/$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 "$BACKUP"
APP_CID=$(dc ps -q app)
test -n "$APP_CID"
dc images --format json > "$BACKUP/images.json"
docker inspect "$APP_CID" --format '{{.Image}}' > "$BACKUP/app-image-id"
docker inspect "$(dc ps -q socket)" --format '{{.Image}}' > "$BACKUP/socket-image-id"
cp compose.taskboard.yaml deploy/RELEASE_SNAPSHOT.json "$BACKUP/"
# Прежний env сохранить отдельно зашифрованным в закрытом хранилище владельца.
dc stop app socket
dc exec -T db sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' > "$BACKUP/database.dump"
test -s "$BACKUP/database.dump"
dc exec -T db pg_restore --list < "$BACKUP/database.dump" > "$BACKUP/database.toc"
# docker cp читает файловый том остановленного app; сохраняет ту же точку остановки.
docker cp "$APP_CID:/data/attachments/." - > "$BACKUP/attachments.tar"
test -s "$BACKUP/attachments.tar"
tar -tf "$BACKUP/attachments.tar" > /dev/null
dc exec -T db sh -ec 'psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c '\''SELECT count(*) FROM "Task"; SELECT count(*) FROM "User"; SELECT count(*) FROM "TaskRequest";'\''' > "$BACKUP/counts.txt"
(cd "$BACKUP" && sha256sum database.dump attachments.tar images.json app-image-id socket-image-id compose.taskboard.yaml RELEASE_SNAPSHOT.json counts.txt > SHA256SUMS)
chmod 600 "$BACKUP"/*
# Возобновлять только после успешного завершения всей пары.
dc start app socket
```

Сохранить оба прежних образа через `docker image save` по ID из файлов (и migrate
для новой схемы) в закрытом хранилище. Проверить checksum после копирования backup
в согласованное зашифрованное внешнее хранилище. Срок хранения/расписание/владелец
и успешная обратная загрузка требуют фактической приёмки; публично не публиковать.

## 4. Restore исключительно в отдельный тестовый проект

Использовать отдельный разрешённый тестовый Docker host с достаточной RAM,
без production credentials и маршрутов внешней отправки. Из раздела 3 получить
оба файла пары и checksum. Рабочий `taskboard_pgdata` не монтировать.
В закрытом `.env.restore-test` заранее задать POSTGRES_DB=taskboard_restore_test,
новые POSTGRES_USER/PASSWORD, NEXTAUTH_SECRET/INTERNAL_EMIT_SECRET, тестовые URLs,
SMTP sink, выключенные cron/внешние отправки. Не копировать production env.

```sh
export COMPOSE_PROJECT_NAME=taskboard-restore
export COMPOSE_ENV_FILES=.env.restore-test TASKBOARD_ENV_FILE=.env.restore-test
# Порты на тестовом host, не публичные:
export TASKBOARD_APP_PORT=28766 TASKBOARD_SOCKET_PORT=28767
test "$COMPOSE_PROJECT_NAME" = taskboard-restore
dc config --quiet
(cd "$BACKUP" && sha256sum --check SHA256SUMS)
dc up -d db
docker image tag "$(cat "$BACKUP/app-image-id")" taskboard-app:restore-baseline
docker image tag "$(cat "$BACKUP/socket-image-id")" taskboard-socket:restore-baseline
export TASKBOARD_VERSION=restore-baseline
dc exec -T db sh -ec 'test "$POSTGRES_DB" = taskboard_restore_test; psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM pg_tables WHERE schemaname = '\''public'\''"' > "$BACKUP/restore-empty.txt"
test "$(cat "$BACKUP/restore-empty.txt")" = 0
dc exec -T db sh -ec 'test "$POSTGRES_DB" = taskboard_restore_test; pg_restore --exit-on-error --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$BACKUP/database.dump"
dc create --no-build --no-deps app
RESTORE_APP=$(dc ps --all -q app)
docker cp - "$RESTORE_APP:/data/attachments" < "$BACKUP/attachments.tar"
# Только восстановленный проектный том; app ещё остановлен.
dc run --rm --no-deps --user 0 --entrypoint sh app -ec 'chown -R 1001:1001 /data/attachments; chmod 700 /data/attachments'
dc exec -T db sh -ec 'psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c '\''SELECT count(*) FROM "Task"; SELECT count(*) FROM "User"; SELECT count(*) FROM "TaskRequest";'\''' > "$BACKUP/restore-counts.txt"
diff -u "$BACKUP/counts.txt" "$BACKUP/restore-counts.txt"
dc up -d --no-build app socket
dc ps
```

Не запускать migrate до проверки исходного restore. Затем проверить схему и
миграционный baseline, скачать выборку файлов через авторизованный API,
сравнить SHA256 с исходной выборкой, проверить отсутствующие/orphan references,
права и видимость. Числа строк и `pg_restore --list` сами по себе недостаточны.
После доказательств остановить `dc down` без `-v`; удаление тестовых данных отдельно.

## 5. Репетиция rollback

Фактическая приёмка #83 от 26.10.2026: [парный 5e→a60 rollback](ROLLBACK_PAIR_ACCEPTANCE_2026-10-26.md).
На свежем изолированном клоне зашифрованной пары 5e заменены **обе** службы,
без пересборки и DDL. Повторены USER login/read/write/file SHA/socket rejoin,
отрицательные подписки и идемпотентный replay. Все исходные 39 таблиц/497 строк
и файлы копии после удаления своих fixtures совпали по counts/crypto hashes.
Monotonic last-good→первый authenticated read: 5.891с; до полного read/write/event
и отрицательных проверок: 8.149с. Подтверждённый marker сохранён 1/1.
Это наблюдаемый результат этой пары, не SLA и не доказательство rollback нынешнего
072 production. Точные IDs, команды, source hashes и cleanup — в связанном отчёте.

Следующие команды — исторический план от 22.10; фактический тест выше использовал
оригинальные сохранённые образы и отдельный clone controller без Compose/migrations.

На том же тестовом проекте, после restore, проверить прежний образ, затем задать
`export TASKBOARD_VERSION=<проверенный новый snapshot ID>` и применить новую миграцию
через `dc --profile tools run --rm --no-deps migrate`, запустить новый
образ и повторить раздел 2. До этого сохранить прежние app/socket IDs.
Для совместимой схемы вернуть **сохранённые** образы без пересборки:

```sh
dc stop app socket
docker image tag "$(cat "$BACKUP/app-image-id")" taskboard-app:rollback-rehearsal
docker image tag "$(cat "$BACKUP/socket-image-id")" taskboard-socket:rollback-rehearsal
export TASKBOARD_VERSION=rollback-rehearsal
dc up -d --no-build --pull never app socket
dc ps
```

Повторить login/read/write/file SHA256/socket и проверить отсутствие потери строк.
Если схема несовместима, не выполнять SQL rollback на рабочей БД: поднять ещё один
пустой тестовый проект с префиксом `taskboard-rollback-test`, восстановить **оба**
артефакта раздела 4, использовать прежние образы и повторить приёмку. Переключение
production на восстановленную пару требует отдельного разрешения владельца,
плана обработки записей после backup и согласованного RPO/RTO. `migrate resolve`
не отменяет SQL. Не использовать reset/db push/seed/down -v/prune.

## Remaining — исторический список 22.10.2026

Для состояния на 26.10 см. [production state](PRODUCTION_STATE.md),
[backup policy #82](../docs/engineering/BACKUP_POLICY_2026-10-26.md) и
[фактический paired rollback #83](ROLLBACK_PAIR_ACCEPTANCE_2026-10-26.md).
Следующий исходный список не отменяет опубликованную последующую приёмку.

Не выполнены: build/доставка immutable образов, server preflight, миграции,
production/browser/SMTP/ACL/realtime приёмка, согласованный backup пары,
off-host copy, реальный restore и rollback rehearsal, замер RPO/RTO,
проверка retention 30 дней. VPS не посещался. Эти пункты не считаются PASS.
