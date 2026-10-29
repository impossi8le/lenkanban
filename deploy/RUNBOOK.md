# RUNBOOK — пакет taskboard (#72–#74)

Перед обновлением действующего production прочитать [PRODUCTION_STATE.md](PRODUCTION_STATE.md).
Инструкции ниже о создании `.env` и первом администраторе относятся только к первой установке.
Существующий `.env.taskboard`, БД, файлы и настройки телеметрии сохраняются при обновлении.

Актуальная инструкция: [RUNBOOK_ACCEPTANCE.md](RUNBOOK_ACCEPTANCE.md).
Она содержит точные команды приёмки, остановки записи, backup пары БД+файлы,
восстановления в отдельный тестовый проект и репетиции отката по сохранённым image ID.
Старые неполные примеры заменены этой инструкцией.

**Только первая установка:** владелец готовит закрытый каталог /opt/taskboard: копирует проверенный release
по [manifest](RELEASE_MANIFEST.md), создаёт `.env.taskboard` из
`deploy/taskboard.env.example`, заполняет секреты локально. Реальные `.env*`
не входят в публикацию. `TASKBOARD_VERSION` берётся из `RELEASE_SNAPSHOT.json`;
git commit неизвестен. Пустые секреты и validation fixture запрещены в production.

Перед первой установкой нужны разрешение владельца, [preflight](PREFLIGHT.md),
проверенные app/socket/migrate образы, проверка schema/baseline по
[DB_BOOTSTRAP_TASKBOARD.md](DB_BOOTSTRAP_TASKBOARD.md), рабочий SMTP и план первого
администратора. Не назначать администратора через произвольный SQL.
Nginx/HTTPS настраивает владелец по `deploy/nginx/taskboard.conf.template` после
loopback smoke; проверить `nginx -t` перед reload.

Compose публикует только loopback: app18766; socket задаётся TASKBOARD_SOCKET_PORT. В PRODUCTION_STATE записан socket18768, как и в env examples; fallback Compose18767 не заменяет рабочий env. Текущие порты/upstream нужно сверить read-only перед выкладкой. Своя PostgreSQL, сеть и тома.
Redis отсутствует. Production local attachments находятся в проектном томе.
При `-p taskboard` имена taskboard_pgdata/taskboard_attachments/taskboard_net
сохраняются; отдельный тестовый проект получает собственные ресурсы.

**Историческая локальная проверка 22.10.2026:** `config --quiet` на синтетическом env — exit 0
(Docker предупредил об отказе чтения пользовательского config.json),
`npx.cmd tsc --noEmit` — exit 0. Это не проверка Docker daemon или runtime.
В рамках этой проверки публикация, SSH, VPS, миграции и backup/restore/rollback не выполнялись. Это не описание сегодняшнего production: позднейшая активация записана в PRODUCTION_STATE и журнале активации.

**Следующее обновление существующего стека:** выполнить свежий [preflight](PREFLIGHT.md), сверить реальные image ID/версию/health и несекретные ports/flags, подготовить backup пары DB+files и закрытую копию настроек по RUNBOOK_ACCEPTANCE. Сохранить project `taskboard`, рабочий `.env.taskboard`, секреты, pgdata/attachments volumes и telemetry timer. Не создавать первый admin, не запускать demo setup/seed/reset и не подменять env шаблоном. Наличие текущих контейнеров, каталога, vhost и сертификата ожидается; их отсутствие требует диагностики, а не автоматической первой установки. Миграции и restart выполняются только отдельным принятым планом. Этот docs-only пересмотр не является текущим SSH/preflight или разрешением deployment.
