# Проверка Kanban DnD v2

Сверено с исходниками 20.10.2026. Это инструкция локального прогона, а не новый отчёт о прохождении. Настоящая сверка не запускала браузеры, PostgreSQL или команды изменения схемы.

## Обязательное окружение

Нужны установленные зависимости, браузеры Playwright и отдельная одноразовая PostgreSQL-база с именем, оканчивающимся ровно на `_test`. `E2E_DATABASE_URL` передаётся через локальное окружение и не сохраняется в документации. Не использовать shared/staging/production БД, даже если её имя подходит guard.

playwright.config.ts (`../playwright.config.ts`; исходник/артефакт не входит в публикацию) и safety.cjs (`../e2e/fixtures/safety.cjs`; исходник/артефакт не входит в публикацию) проверяют URL до запуска server и до создания Prisma client. Разрешены PostgreSQL URL с одним декодированным сегментом имени БД, без слешей/обратных слешей и их encoded вариантов. Проверка суффикса не доказывает, что база безопасна для удаления fixture.

База должна уже содержать схему этого checkout. Репозиторная история миграций не гарантирует bootstrap пустой базы. Подготовка схемы — отдельный шаг только для подтверждённой пустой одноразовой БД; не переносить `db push` на существующий стенд, не добавлять `--accept-data-loss` и не выполнять reset рабочей базы. Значение `DATABASE_URL` сервера должно соответствовать `E2E_DATABASE_URL` fixture.

После безопасной подготовки схемы и переменной `E2E_DATABASE_URL`:

```powershell
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:3555'
$env:E2E_DND_V2_ENABLED = 'true'
npx playwright test e2e/kanban-dnd-v2.spec.cjs e2e/kanban-theme-accessibility.spec.cjs --project=chromium
```

Без `--project` выполняется матрица пяти проектов. Managed server запускает `npm run dev -- --hostname 127.0.0.1 --port 3555`, не переиспользует уже запущенный процесс и получает тестовый DATABASE_URL и NextAuth URL/secret из config. Секрет генерируется случайно, если `E2E_NEXTAUTH_SECRET` не задан.

Для заранее запущенного изолированного сервера нужно точное `PLAYWRIGHT_EXTERNAL_SERVER=1`. В этом режиме оператор сам обеспечивает совпадение БД и auth-настроек fixture/server. Иной HTTP(S) origin разрешён только в external-режиме; production hostname и его поддомены guard блокирует. Managed-режим принимает только точный `http://127.0.0.1:3555`.

Default `testMatch` включает только `kanban-dnd-v2.spec.cjs` и `kanban-theme-accessibility.spec.cjs`; старые smoke specs со встроенным удалённым адресом не загружаются обычным `npm run test:e2e`.

## Изоляция и cleanup

isolated-project.cjs (`../e2e/fixtures/isolated-project.cjs`; исходник/артефакт не входит в публикацию) на каждый тест создаёт пользователя с подтверждённой почтой, проект, четыре колонки и Task A–D. Run ID помечает пользователя, проект и описания. Флаг `Project.dndV2Enabled` задаётся для fixture; login rate-limit имеет ключ `e2e-<run ID>`.

Cleanup в finally независимо удаляет точный проект, пользователя и rate-limit key, сверяя ID и полный run-маркер, затем отключает Prisma. Ошибки cleanup объединяются с исходной ошибкой. Это не механизм очистки произвольной базы: не выполнять общие deleteMany вручную и не переиспользовать данные production.
## Матрица

Проекты Playwright:

- Chromium / Desktop Chrome — pointer, keyboard, menu, theme, axe;
- Firefox / Desktop Firefox — pointer, keyboard, menu, theme, axe;
- WebKit / Desktop Safari — pointer, keyboard, menu, theme, axe;
- Pixel 7 — tap/menu, keyboard, theme, axe; synthetic mouse drag пропускается;
- iPhone 13 — tap/menu, keyboard, theme, axe; synthetic mouse drag пропускается.

Проверки темы прикладывают артефакты light, dark и system при размерах:

- desktop — 1440×900;
- tablet — 1024×768;
- mobile — 390×844.

Для theme/accessibility сценариев включается
`page.emulateMedia({ reducedMotion: "reduce" })`. После единственного выбора
system тест меняет системную схему dark → light → dark и проверяет смену
resolved class без повторного открытия меню.

## Что покрывает набор

`e2e/kanban-dnd-v2.spec.cjs`:

- точный порядок внутри колонки и сохранение после reload;
- перенос между колонками, возврат и пустая колонка;
- восстановление после `Escape` и drop вне колонок без move-запроса;
- click/tap меню перемещения (на touch tap выполняется и для trigger, и для
  menu item), возврат фокуса и русское live-region сообщение;
- keyboard grab/cancel и русские DnD announcements;
- отключение drag при фильтре и сортировке не по позиции;
- rollback при принудительном `409`;
- rollback при сетевой ошибке и успешная повторная попытка;
- отсутствие неожиданных console errors и неуспешных move-запросов в успешном
  сценарии.

`e2e/kanban-theme-accessibility.spec.cjs`:

- артефакты light/dark/system на desktop/tablet/mobile;
- pixel-based контраст поверх реально отрисованного gradient: текст/handle
  временно становятся прозрачными, screenshot декодируется через `sharp`, а
  foreground alpha композится с каждым фоновым пикселем;
- худший контраст текста каждой priority-карточки: `4.5:1` для обычного и
  `3:1` для крупного текста;
- худший контраст drag handle не менее `3:1`;
- фактическая priority-кромка сравнивается с соседними пикселями и внутри, и
  снаружи карточки; минимальный из двух ratios должен быть не менее `3:1`;
- axe без serious/critical нарушений на доске, в открытом move menu и при
  открытой задаче.

## Mutation-проверка legacy-флага

Обычный запуск всегда создаёт fixture с `dndV2Enabled=true`. Legacy-режим
разрешается только двумя явными переменными; это не меняет существующие
проекты:

```powershell
$env:E2E_DND_V2_ENABLED="false"
$env:E2E_ALLOW_LEGACY_FLAG_MUTATION="1"
npx playwright test e2e/kanban-dnd-v2.spec.cjs --project=chromium
```

Этот opt-in меняет только DnD adapter fixture-проекта. `legacy-mutation.cjs` оставляет два сценария: `same-column order persists after reload` и `keyboard drag announces Russian instructions and Escape restoration`, остальные пропускаются. Историческое ожидание «2 failed, 9 skipped» нельзя считать актуальным результатом: legacy-код после этого развивался, а keyboard-ветка E2E всё ещё содержит предположение об отсутствии современного handle. Перед использованием mutation как release-gate пересверить её ожидания с текущим legacy UI. Не считать неожиданное падение доказательством правильной работы приложения.

Флаг не меняет глобальный theme CSS. Проверка устойчивости к CSS mutation — отдельный локальный эксперимент; в этой сверке не выполнялась.
## Результаты и границы проверки

Историческая версия документа содержала результаты отдельной ветки (включая build и baseline lint/typecheck) и прямо указывала, что browser suite тогда не запускался. Эти числа не считаются состоянием текущего checkout. Для датированных свидетельств см. [DND_RECHECK_2026-09-15.md](DND_RECHECK_2026-09-15.md); пересверка документа 20.10.2026 не подтверждает новый passing-прогон.

Перед выпуском выполнить выбранную матрицу на изолированном стенде и сохранить commit, дату, команды, итог, причины skip и артефакты. Конфигурация сохраняет trace при первом retry, screenshot/video при ошибке; HTML reporter не открывается автоматически. Mobile-проекты пропускают synthetic mouse drag, поэтому их успех не означает проверку физического touch drag.

Ручная проверка NVDA + Firefox и VoiceOver + Safari остаётся отдельной: инструкции grab/drop, последовательность announcements, возврат фокуса после успеха/ошибки и чтение move menu. Визуально проверить pointer, reload после reorder, keyboard/menu alternative, light/dark/system, 390×844, console и network. Протокол — [MANUAL_ACCESSIBILITY_TESTING.md](MANUAL_ACCESSIBILITY_TESTING.md).

## Откат адаптера

`Project.dndV2Enabled=false` выбирает legacy-адаптер только у конкретного проекта. Это изменение данных, которое требует проверенного окружения, точного project ID и сверки текущего имени проекта. Не выполнять массовый update. Изменение флага не удаляет endpoint, rank-поля, задачи или миграции и не заменяет проверку совместимости legacy. После изменения проверить порядок, перенос, reload, меню и клавиатуру; обратное включение — тот же точный проект с флагом true.

