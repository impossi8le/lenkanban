# Каноническая visual CI · #60

Новая отдельная lane — `.github/workflows/visual-canonical.yml`. Windows workflow сохраняет функциональные E2E, но больше не сравнивает Linux PNG. Приложение не запекается в renderer: в контейнер монтируется текущий checkout, там выполняются locked `npm ci`, Linux build и существующий managed server на loopback3555. Ни образ, ни эталоны workflow не публикует и не коммитит.

## Закреплённая среда

`deploy/visual-ci/Dockerfile` использует публичный MCR Playwright1.58.2-noble с manifest digest6446946a…d63d, копирует **только** Node22.22.2 binary из закреплённого official Nodeamd64 digest868499d5…3201 и сохраняет npm11.6.2 из MCR. Дополнительно установлены ровно NotoCore и NotoMono версии20201225-2. Liberation и NotoColorEmoji уже входят в закреплённую базу.

Это выведено из read-only сравнения принятого TEST renderer3ac2a… с MCR: Chrome binary совпадает, dpkg delta содержит только эти два Noto-пакета. `renderer.expected.json` измерен на3ac2a…; `renderer.mjs` проверяет Node/Chrome binary SHA, версии, весь installed-package manifest, font files, fontconfig и разрешённый font list. Несовпадение — setup FAIL, а не автоматическое обновление manifest. Kernel записывается отдельно, CPU/host всё ещё могут влиять на raster: успешная сборка recipe не гарантирует прохождение image diff.

Recipe пока не собран и GitHub job не выполнен. Это не утверждение идентичности нового CI image до его проверок, не CI PASS и не production image. Опубликованный manifest digest Node проверен через registry metadata; реальный binary hash дополнительно обязан совпасть при build.

## Включение и режимы

Lane работает только на доверенном default branch, при `RUN_CANONICAL_VISUAL_TESTS=true`, в environment `integration-tests`. Нужен отдельный prepared `VISUAL_E2E_DATABASE_URL`, доступный из Docker и заканчивающийся `_test`; старый общий secret не переиспользуется автоматически. Workflow не создаёт БД, не выполняет migrations/seed/reset и не подключается к внешнему приложению. Секрет передаётся через environment, не через значение командной строки. SMTP указывает на локальный неслушающий port9; Sentry и sockets выключены. Обычные проверки и ручные captures этой lane сериализованы.

Обычный запуск: updatesnone, retries0,12projects,276tests. `coverage.cjs` требует **точные** 300 PNG +300 sidecars для25изображений каждого из12проектов, включая реальные имена состояний/экранов. Проверяются hash/provenance, viewport/project, Linuxx64/PW/browser и pixel policy; лишний файл или замена одного имени другим — FAIL. Это дополняет прежний валидатор непустого набора, а не заменяет actual acceptance.

Ручной `workflow_dispatch` с `capture=true` явно создаёт provisional refs в `e2e/artifacts/provisional-baselines`, сохраняя root `E2E_UPDATE_BASELINES=0`. Отдельный CI config разрешает `updateSnapshots:all` только при этом событии и `E2E_CI_UPDATE_BASELINES=1`; fixture также проверяет явный manual режим. Версионируемые baseline пути не переписываются. После успешного capture coverage guard проверяет все300пар. Нужны review и fresh compare перед переносом конкретных файлов в `e2e/baselines`; перенос не автоматизирован.

Артефакты: синтетические expected/actual/diff, HTML/JSON, renderer proof и manual provisional refs. Storage, env и auth state не загружаются. Traces/videos остаются выключенными: post-auth trace по критерию #60 требует отдельного безопасного решения, а не включения записи входа с credentials.

## Непроверенный конфликт

Полный и scoped LeanCTX reads существующего `.github/workflows/ci.yml` withheld (`secret.redacted`, `redaction.incomplete`); файл не читался обходным путём и не менялся. Ранее разрешённый bounded search показал в нём отдельный Linux visual job с незакреплённой установкой fonts. Его полное поведение и concurrency не проверены. Новая lane не отключает этот job и не доказывает, что он совместим с новыми PNG. Поэтому новая lane намеренно gated отдельно и требует отдельную prepared DB. До её включения необходимо разрешить конфликт старой lane и подтвердить CI конфигурацию. Этот остаток, trace и actual full matrix не считать завершёнными по одному новому workflow.
