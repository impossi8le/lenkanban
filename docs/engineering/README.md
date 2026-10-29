# Общая основа реализации

26.10.2026: кеширование запросов и устранение тяжёлого SQL-плана —
[контракт](REQUEST_CACHING_2026-10-26.md),
[фактическая выкладка](../../deploy/REQUEST_CACHE_PRODUCTION_2026-10-26.md).
Следующее расширение диагностики и отчёт о проблеме —
[контракт](REQUEST_OBSERVABILITY_2026-10-26.md); наличие плана не означает готовую реализацию.

25.10.2026: редизайн реализован и активирован на production —
[результат](../../deploy/REDESIGN_PRODUCTION_2026-10-25.md),
[контракт переноса](../REDESIGN_IMPLEMENTATION_2026-10-25.md).

Актуальная общая приёмка 23.10.2026 — [release gate](RELEASE_GATE_2026-10-23.md).
Он содержит новые реальные PG/browser проверки, найденные регрессии и оставшиеся
блокеры; исторические зелёные снимки ниже не подтверждают текущий релиз.

23.10.2026: упрощение доски и карточки по 22 пользовательским комментариям,
права на назначение и изменение срока —
[контракт UI](UI_SIMPLIFICATION_2026-10-23.md).
Локальная реализация и проверки не означают публикацию на production.

23.10.2026: изменения действующего production и правила сохранения при следующей
выкладке — [PRODUCTION_STATE.md](../../deploy/PRODUCTION_STATE.md).
Старые снимки ниже не являются инструкцией отката production.

22.10.2026, локальная подготовка #72/#73/#74 и уточнение #2:
[manifest](../../deploy/RELEASE_MANIFEST.md), [приёмка/backup/restore/rollback](../../deploy/RUNBOOK_ACCEPTANCE.md),
[актуальный аудит](../audit/CURRENT_2026-10-22.md). Compose config на синтетическом
env exit 0, `npx.cmd tsc --noEmit` exit 0. Целевые TaskRequest/file tests:
72 passed / 32 failed (3 failed files / 1 passed), общий gate не принят.
Creator TaskRequest и файловые маршруты уже реализованы: прежняя матрица
от 21 октября в этих строках устарела. Публикация и VPS не выполнялись.

Новейший снимок: [волна33](WAVE_33_RESULTS_2026-10-21.md) и [волна34](WAVE_34_RESULTS_2026-10-21.md): legacy Task DELETE и socket edit/delete/react через existing transactional shared guard; свежие actor/author проверки, committed ACK и безопасные effects. **3709passed/0failed/81pending=75PG+6existingcomponents**,186files; build56/56exit0, nonincrementaltypes0, target5lint0errors1oldwarning. FullLint8errors41warnings. Реальные PG/auth/socket E2E и весь lifecycle/private ещё не приняты.

Исторический снимок: [волна30](WAVE_30_RESULTS_2026-10-21.md), [волна31](WAVE_31_RESULTS_2026-10-21.md), [волна32](WAVE_32_RESULTS_2026-10-21.md): guarded socket SEND/replay/P2002, bounded24h telemetry renewal с Antigravity helper и −7 lint errors в3type-only файлах. **3577passed/0failed/81pending=75PG+6existingcomponents**,184files; finaltypes/target13lint0errors6oldwarnings,build56/56exit0. FullLint9errors41warnings; first3575/2/81 и дваSSRbuildfailures сохранены/исправлены. NativeCLIfile generation проверена, rootfullmatchfix/tests; no alltoolapproval/isolationclaim. Общий lifecycle/private/DBruntime ещё не готов.

Исторический снимок: [волна28](WAVE_28_RESULTS_2026-10-21.md) и [волна29](WAVE_29_RESULTS_2026-10-21.md): metadata attachmentsPATCH и HTTPmessagesPOST через existing transactional guard. **3429passed/0failed/81pending=75PG+6existingcomponents**,177files; build56/56exit0, finalnonincrementaltypes/target5lint0 послеtest-onlyfalseprojectionrepair (focused41passed). Full3429 был передэтойfixtureправкой; новогоfullпосленеёне заявляем. FullLint16errors42warnings unchanged; noactivation/PGapply. Nextsocket-send и24htelemetryrenewal contracts/scouts/reviews готовы, не реализация.

Исторический снимок: [волна26](WAVE_26_RESULTS_2026-10-21.md) и [волна27](WAVE_27_RESULTS_2026-10-21.md) параллельно: fresh transactional assignee guard/Activity/committedDTO и notification-only automation catalog/API/UI/per-rule atomic persistence/exact delivery rows. **3368passed/0failed/81pending=75PG+6existingcomponents**,175files; types/target13lint0,build56/56exit0. FullLint16errors42warnings (processor−28errors). SyntheticIAB320light/1280dark; realDB/authE2Eнет. #41теперьwork,#65/#32work/#39testing; noactivation/apply. Другойчат#51UIcounts не приписываютсянам.

Исторический снимок: [волна24](WAVE_24_RESULTS_2026-10-21.md) и [волна25](WAVE_25_RESULTS_2026-10-21.md) параллельно: bulkPOSTscalar guard с прежним ADMINowner/memberограничением, tagsguard/mandatorytxActivity/committedDTO/safeeffects. **3183passed/0failed/81pending=75PG+6existingcomponents**,164files; finaltypes/target5filelint0,build56/56exit0. FullLint44errors42warnings, peerBoard9warningsremoved не нашаправка. #32/#65work/#39testing; noactivation/DBapply. Nextassignee иnotification-onlyautomation scouts готовы, не реализация.

Исторический снимок: [волна22](WAVE_22_RESULTS_2026-10-21.md) и [волна23](WAVE_23_RESULTS_2026-10-21.md) выполнены параллельно: checklistcreate/delete и whole-setscalarprioritybulkPATCH guards через существующие service/access/marker/Activity. **3112passed/0failed/81pending=75PG+6existingcomponents**,162files; finaltypes/target8filelint0,build56/56exit0. First3101/2/81 иbuildimportfailure сохранены, fixture/peerUI fixes проверены отдельнымfinalgreen. FullLint44errors51warnings (+9peerBoardwarnings), #32/#65work/#39testing. Noactivation/DBapply; bulkPOST/mixedglobalorder/automation/otherchild/delete/channels остаются.

Исторический снимок: [волна21](WAVE_21_RESULTS_2026-10-21.md):3independenttype-only files ActivityTimeline/ProjectColumnsDialog/RecurringTaskDialog,32existingtests/types/targetlintgreen/build56/56exit0. **FullLint44errors42warnings** (−4errors), no runtimechange/no fabricatedsnapshot/transpileclaim. НовыйfullVitestнеповторялся; нижеwave20общийgate2notificationfailures остаётсяred. #32/#65work; nextfunctionalchecklistcreate/delete илиscalarbulk поready scouts, layout#43другогоownerнетрогать.

Исторический снимок: [волна20](WAVE_20_RESULTS_2026-10-21.md): legacyflat/mixedPATCH guard/fresh transactional auth реализованы, targeted112passed/types/targetlint0/build56/56exit0. **Full2976passed/2failed/81pending**,155files: два notificationcomponent/jsdom computed-style сбоя в параллельной#43, isolated5passed/2failed; firstfailedJSON сохранён, общийgate НЕgreen. FullLint48errors42warnings, снижениеnotification-bell другогочата не приписываетсяwave20. #65/#32work/#39testing; noactivation/PG/apply. Wave21 три independent type-onlyfiles, layoutowner не затрагивается.

Исторический снимок: [волна19](WAVE_19_RESULTS_2026-10-21.md):3параллельных type-only lintfix(AutomationRuleDialog/AssigneeSelector/export), **fullLint49errors44warnings** вместо58/45; rootfinaltypes/target3filelint0,build56/56exit0. Existing27componenttestspassed, новыйfullVitest не запускался для этихtype-only edits; ниже wave18full исторический. Payload/runtime/fallback сохранены, no rules/suppression/schema changes. #32 остаётся«В работе». Далее legacyflat/mixedPATCH guard вложеннойкомандой(coordinator+2children в общемcap4).

Исторический снимок: [волна18](WAVE_18_RESULTS_2026-10-21.md): общий guardedappend вTaskcreation/templateuse/recurrence, siblingTasklocks+actualwrite-set+batch200 ДОtemporarywrite, fixed409 и прежнийcron per-candidate failure. Rootaliasfinding fixed normalizedIDs+regression. **2946passed/0failed/81pending=75PG+6existingcomponents**,153files; finaltypes/targetlint0,build56/56exit0; fullLint58/45 доwave19. Schema/canonical/purepolicy/batch/rank/access/Activity8hashes unchanged; noactivation/apply. Creationfresh-auth/templatechildatomicity/allwriters/channels остаются open.

Исторический снимок: [волна17](WAVE_17_RESULTS_2026-10-21.md): DnD/canonical relocation fresh transactional auth+required targetguard до replay/samecolumn/append, batch200 siblingguard до temporaryrankwrites; safe409 во4API. **2894passed/0failed/81pending =75PG+6existingcomponent skips**,151files; rootfinaltypes/target10filelint0,build56/56exit0; fullLint58errors45warnings. Schema/migration/purepolicy/appendrank/rankengine/access/Activity7hashes unchanged; миграции не применены. UIunchanged/browserQA N/A, realauth/API/DBE2E нет. Bulkglobalorder/genericappend/остальныеwriters/channels открыты; ни firstmarkedrow, ни private/OWN/internal не включены. Далее общий maintenanceguard creation/template/recurrence.

Исторический снимок: [волна16](WAVE_16_RESULTS_2026-10-21.md): additive TaskRequest + закрытый decoder и общий injected guard в scalar/checklist после fresh auth до receipt. Только2границы, все marked/malformed отклоняются, legacy null сохраняется; marker creation/activation отсутствуют. **2812passed/0failed/77pending =71PG+6existingcomponent skips**,148files; finaltypes/target10filelint и activityfixturelint0,build56/56exit0; fullLint58errors/45warnings. Первый2809/3/77 сохранён, narrow oldfixture null-adapter25passed без ослабления assertions, отдельный finalfullgreen. Offline7DDL+2CHECK match/validate0, migration20261021090000_task_request_marker подготовлена НЕ применена. UIunchanged/browserQA N/A; realauth/API/DBE2E нет. Далее DnD/canonicalrelocation target+rank-maintenance guards; private/OWN/internal выключены.

Исторический снимок: [волна15](WAVE_15_RESULTS_2026-10-21.md): общий TaskCommandPanel/протокол во всех3карточках, actor-scoped MyTasks с freshGET передкаждымopen, exactretry/409/read-onlyretry. Закрыты emptylist503-unmount и403→503cachedtitles findings. **2632passed/0failed/71pending =65PG+6existingcomponent skips**,144files; finaltypes/target13filelint0,build56/56exit0; fullLint58errors/45warnings. Clock/visibility test-readiness failures сохранены, assertions/timeouts/production не ослаблены; отдельный finalfullgreen. SyntheticChrome standalone320light/MyTasks1280dark+320light выполнен, realauth/API/DBE2E нет. Schema/API/migrations не менялись. Далее additive marker/denialplanner и первые2guardboundary, activationoff до всехwriters/каналов; private/OWN/internal не включены.

Исторический снимок: [волна14](WAVE_14_RESULTS_2026-10-21.md): strict Task details-save с existing Task.version/CAS/mandatory Activity/receipt и реальный boardmodal consumer, exact retry/409/refetch, server actor binding. **2584passed/0failed/71pending =65PG+6existingcomponent skips**,143files; finaltypes/targetlint0errors/5knownwarnings,build56/56staticexit0; fullLint60errors/51warnings. OfflineSQL3/3match/validate0, migration подготовлена/неприменена. First2582/2/71 сохранён, narrow historyfixture repair20passed и отдельный fullgreen. SyntheticChrome320light/1280dark выполнен, realauth/API/DBE2E нет. Далее standalone/my-tasks reuse, marker/planner/всеwriterguards и каналы; private/OWN/internal не включены.

Исторический снимок: [волна 9](WAVE_9_RESULTS_2026-10-21.md): ADMIN привязки досок к подразделениям и группам через существующий bindProject; frozen full-target intent/version, стабильный exact retry. **2051 passed /61 PostgreSQL skipped**, TypeScript/целевой lint прошли, build55/55exit0. Общий lint63errors/53warnings. DnD test readiness исправлена без ослабления проверок; первый2050/1/61 сохранён. Synthetic Chrome320light/1280dark выполнен, real auth/API/DB E2E не подтверждён. Следом защита role management/последнего ADMIN, scoped policy и каналы. Миграции не применены.

Новейший снимок: [волна 8](WAVE_8_RESULTS_2026-10-21.md): ADMIN назначение/снятие руководителя и основного подразделения, стабильный X-Action-Id; исправлен409 dismissal bypass во всех трёх orgредакторах. **1963 passed /61 PostgreSQL skipped**, mail128, TypeScript/целевой lint прошли, build54/54 exit0. Общий lint63errors/53warnings. Synthetic Chrome320light/1280dark выполнен, реальный auth/API/DB E2E не подтверждён. Следом Project orgbindings, scoped policy и каналы; миграции не применены.

Новейший снимок: [волна 7](WAVE_7_RESULTS_2026-10-20.md): ADMIN группы и участники через прежний аудируемый сервис, общий people picker, исправление Origin waiver. **1828 passed / 61 PostgreSQL skipped**, mail 128, типы и целевой lint прошли, build 54/54 exit 0. Общий lint: 63 ошибки / 53 предупреждения. Synthetic component Chrome QA: 320 light / 1280 dark; реальный auth/API/DB E2E не подтверждён. Следом — leader/primary department/project bindings, scoped policy и каналы. Миграции не применены.

20.10.2026: через GitHub подтверждены 63 открытые задачи репозитория `lenremont2/kanban_pochta`. Этот каталог задаёт общие технические правила для их реализации. Он не подтверждает выполнение критериев продуктовых задач.

| Основа | Контракт | Применение |
| --- | --- | --- |
| Журналирование, диагностика и корреляция | [LOGGING_CONTRACT.md](LOGGING_CONTRACT.md) | #20, #54–#58 и все новые API/UI операции |
| Тестовая среда и доказательства | [TESTING_CONTRACT.md](TESTING_CONTRACT.md) | #31/#32, #57–#60 и проверки каждой задачи |
| UTC-повторения и закрытые служебные каналы | [RECURRING_CONTRACT.md](RECURRING_CONTRACT.md) | #37/#38/#39; реальная PostgreSQL-приёмка пока не выполнена |
| Сквозной срез телеметрии | [TELEMETRY_VERTICAL_SLICE.md](TELEMETRY_VERTICAL_SLICE.md), [волна4](WAVE_4_RESULTS_2026-10-20.md) | Checklist/receipt/collector, безопасные ошибки и оба раздела ADMIN; покрытие частичное, БД/runtime ещё не приняты |
| Зависимости и параллельная работа | [DEPENDENCY_PLAN.md](DEPENDENCY_PLAN.md) | Все 63 задачи, общие файлы и очередность интеграции |
| Оргмодель и совместимость доступа | [ORGANIZATION_CONTRACT.md](ORGANIZATION_CONTRACT.md), [команды/аудит](ORGANIZATION_COMMAND_CONTRACT.md), [глобальные роли](GLOBAL_ROLE_COMMAND_CONTRACT.md), [привязки досок](ORGANIZATION_PROJECT_BINDING_CONTRACT.md) | #15/#16: nullable metadata, versioned общий сервис, ADMIN Department/Group/assignment/binding editors и audited global role API/UI; scoped grants/каналы следующими срезами |
| Права, состояния, обсуждение и уведомления | [Жизненный цикл](../REQUEST_LIFECYCLE.md) | #3, #7, #15–#20, #34/#40/#41, #65/#66 |
| Системные уведомления браузера | [BROWSER_NOTIFICATIONS_CONTRACT.md](BROWSER_NOTIFICATIONS_CONTRACT.md) | 23.10.2026, P0: foreground-часть реализована; Web Push при закрытой вкладке — следующий объём |
| Исполнимая совместимость project rights | [ACCESS_POLICY_CONTRACT.md](ACCESS_POLICY_CONTRACT.md) | #16: единый pure evaluator в existing getProjectAccess, закрытые источники решений; scoped/OWN/internal ещё не активированы |
| Настройка круга заявителей | [PROJECT_APPLICANT_POLICY_CONTRACT.md](PROJECT_APPLICANT_POLICY_CONTRACT.md) | #16/#17: ADMIN configuration и prospective preview через общие command/reader, отдельно от legacy read/write и будущего lifecycle |
| Явные профили и области | [SCOPED_PRIVILEGE_CONTRACT.md](SCOPED_PRIVILEGE_CONTRACT.md) | #16: ADMIN profiles/assignments/preview, exact organization/department/board scope без implicitgrants; enforcement ожидает lifecycle/изоляцию каналов |
| Защита generic append maintenance | [TASK_APPEND_GUARD_CONTRACT.md](TASK_APPEND_GUARD_CONTRACT.md) | #65/#39:3genericconsumers guarded передsiblingrankwrites, ordinaryappend unchanged |
| Назначения и уведомляющая автоматика | [TASK_ASSIGNEE_GUARD_CONTRACT.md](TASK_ASSIGNEE_GUARD_CONTRACT.md), [AUTOMATION_NOTIFICATION_PHASE_CONTRACT.md](AUTOMATION_NOTIFICATION_PHASE_CONTRACT.md) | Волны26/27: общий транзакционный guard; закрытый каталог notification-only, без активации lifecycle |
| Вложения и HTTP-сообщения | [TASK_ATTACHMENT_GUARD_CONTRACT.md](TASK_ATTACHMENT_GUARD_CONTRACT.md), [TASK_HTTP_MESSAGE_GUARD_CONTRACT.md](TASK_HTTP_MESSAGE_GUARD_CONTRACT.md) | Волны28/29 приняты локально: metadata PATCH/HTTP POST; upload/download/socket/read isolation отдельно |
| Обновление диагностики после24h | [TELEMETRY_RENEWAL_CONTRACT.md](TELEMETRY_RENEWAL_CONTRACT.md) | Волна31 принята локально: lazy new-session rollover, arbitrary401 terminal; collector defaultoff |
| Типовой lintcleanup | [LINT_TYPING_SLICE_CONTRACT.md](LINT_TYPING_SLICE_CONTRACT.md) | #32:9ошибок/1warning устранены,49errors44warnings остаются |
| Защита DnD/canonical relocation | [TASK_MOVE_GUARD_CONTRACT.md](TASK_MOVE_GUARD_CONTRACT.md), [writer coverage](TASK_WRITER_COVERAGE.md) | #65: fresh transactional auth/targetguard/batch siblingrankguard; прочие writers и bulkglobalorder остаются |
| Маркер будущего Task lifecycle | [TASK_REQUEST_MARKER_CONTRACT.md](TASK_REQUEST_MARKER_CONTRACT.md) | #65: отдельная relation, закрытый decoder и2guardboundary; создание marked rows запрещено до всех writers |
| Версионные изменения полей Task | [TASK_COMMAND_CONTRACT.md](TASK_COMMAND_CONTRACT.md) | #65: strict scalar API и все3cardconsumers через общий controller, existing Task.version/Activity/receipt/exact retry; остальные legacy writers и новый lifecycle ещё не переведены |
| MCP-сервер: инструменты, аутентификация и права | [MCP_CONTRACT.md](MCP_CONTRACT.md) | #68: контракт до реализации; #69 — сервер, #71 — изолированное развёртывание; существующие readers/commands/access, без новых прав и обходных записей |

Решения пользователя в этом раунде: подробные события диагностики видят только глобальные администраторы, хранение 30 дней. Первая панель включает оба раздела: ошибки/состояние системы и использование функций. Требования доступа и срока распространяются на хранилища, API чтения, экспорт и внешние обработчики. Реальная настройка хранения и удаления требует отдельной проверки.

Работа разделена между тремя встроенными агентами: журналирование, тестовая основа, карта зависимостей и последующее независимое ревью. Основной агент отвечает за интеграцию и проверку. Через OpenCode запрошен ограниченный аудит без записи в исходники: Go вернул `Go usage limit exceeded` (5 hour), после чего запрос повторён через разрешённый Relay.fast. Relay начал вызовы инструментов, но проверяемый итоговый отчёт не получен; его результат не используется как доказательство приёмки. Повторные платные циклы не запускаются. Проверку изменений выполняют встроенные агенты и основной агент.

Исправлена тестовая основа: установлена явная зависимость `@testing-library/dom`, вложенная копия и служебные/vendor-каталоги исключены из корневых проверок; почтовые `node:test` запускаются отдельной командой `npm run test:mail`, остальные — Vitest. Правила lint не ослаблялись.

Реализован общий технический контекст диагностики: allowlist Pino/Sentry, безопасные ошибки и child bindings, изолированный Sentry scope, серверный requestId и проверяемый actionId, wrapper с фактическим HTTP outcome. Replay и автоматический tracing отключены. Это основа для дальнейшего подключения, не завершённый collector или панель.

## Проверки и оставшийся объём

Новейший снимок: [волна6](WAVE_6_RESULTS_2026-10-20.md), **1677passed/60PGskipped**, mail128, TypeScript/targetlintgreen, build52/52exit0. Все orgmutations теперь audit/receipt/version атомарно, ADMIN управление подразделениями и bounded история реализованы локально; миграции не применены. Synthetic browser component QA320light/1280dark выполнен, реальный auth/DB E2E не подтверждён. Общий lint63errors/53warnings. Следом — groups/membership editors через тот же сервис, затем leader/primarydepartment/project binding и scoped policy/каналы. Старые снимки ниже исторические.

Новейший снимок: [волна5](WAVE_5_RESULTS_2026-10-20.md), **1488passed/59PGskipped**, mail128, TypeScript/targetlintgreen, build50/50exit0. Additive orgschema/service подготовлены; миграция не применена. Старые права досок сохранены, private/internal не включены. Общий lint63errors/53warnings. Следующий срез — долговечный орг-аудит и ADMIN управление подразделениями через тот же сервис, затем группы/привязки/общая policy. Все счётчики ниже относятся к предыдущим снимкам.

Актуальный снимок: [волна4](WAVE_4_RESULTS_2026-10-20.md), **1395 passed /50 PG skipped**, mail128, TypeScript/targeted ESLint green, build50/50 exit0 с прежним Sentry warning. Оба раздела `/admin/telemetry` реализованы локально; global ADMIN и retention проверяются сервером. Общий lint-долг63errors/53warnings. [Точные проверки](../../work/validation/wave4-gate-2026-10-20.md). Старые снимки ниже исторические; следующие работы — расширение каталога/health/renewal и общая оргмодель/права/lifecycle, реальная БД/browser приёмка остаётся открытой.

Последующее продолжение добавило [локальный сквозной срез телеметрии](WAVE_3_RESULTS_2026-10-20.md): UI checklist toggle → API/receipt → collector → ADMIN read/cleanup. **Последний gate:1252 passed /50 PostgreSQL skipped, mail128, TypeScript/target lint30 green, build49/49.** Общий lint-долг63errors/54warnings остаётся. Полная панель, остальные события и PostgreSQL/browser приёмка — следующая работа; прежние результаты ниже относятся к предшествующему снимку.

Волны #36/#37/#38/#39/#52 интегрированы локально. Последний полный gate: **980 passed / 38 PostgreSQL skipped**, отдельно почта **128 passed**; TypeScript и целевой ESLint 18 файлов — exit 0. После снимка добавлены два postcommit API-теста: затронутая выборка 111 passed, повторный typecheck/test lint — exit 0; полный982 не запускался. Общий ESLint остаётся **63 ошибки / 55 предупреждений**. Команды и JSON — в [последнем gate](../../work/validation/wave2-gate-2026-10-20.md); прежний снимок 907/30 — в [wave1 gate](../../work/validation/wave1-gate-2026-10-20.md). [Отчёт волны](WAVE_1_RESULTS_2026-10-20.md) и [контракт повторений](RECURRING_CONTRACT.md) описывают границы; #39 и browser-критерии UI ещё не приняты.

Историческая основа сохранена в [TESTING_CONTRACT.md](TESTING_CONTRACT.md): полный Vitest 711 passed / 30 skipped, затем 31 целевой тест; почта 128 passed, lint 71/56 и прежняя сборка47/47. Последняя сборка после #36/#39/#52 прошла: **46/46 статических страниц**, exit 0, с синтетическим/пустым окружением. [Build evidence](../../work/validation/wave2-build-2026-10-20.md) фиксирует предупреждение OpenTelemetry/Sentry; существующий build config пропускает lint, отдельный lint-долг остаётся.

Чистый `npm ci`, настоящая тестовая БД, браузерные E2E и production не проверялись. Проверка Docker остановлена LeanCTX allowlist до выполнения команды; ограничение не обходилось. Миграции/seed/reset не выполнялись. Созданное часовое продолжение этого чата действует отдельно от текущей работы; повторяющиеся неизменные уведомления не требуются.

Следующие интеграции: [сквозной срез](TELEMETRY_VERTICAL_SLICE.md), затем полный каталог/collector и оба раздела панели с серверным доступом только глобальному администратору и фактическим удалением подробных событий через 30 дней. Затем — общие права, жизненный цикл, защищённые файлы/realtime по [карте зависимостей](DEPENDENCY_PLAN.md). [Передача продолжению](../../work/CONTINUE_WAVES_2026-10-20.md) сохраняет текущий статус, ограничения и следующий порядок. Все 63 issue этим раундом не закрываются; GitHub Status и публикации не изменялись.

Корневой [AGENTS.md](../../AGENTS.md) делает эти контракты входной точкой для следующих агентов. Текущие GitHub Issues и последние решения пользователя имеют приоритет над историческими снимками backlog. Состояние карточек проекта не выводится из локальных документов.

## Параллельный участок #34 и решения #4–#6, 21.10.2026

[Волна #34/1](ISSUE_34_WAVE_1_RESULTS_2026-10-21.md): ограничена числовыми метаданными вложений, целевые 47 route tests и lint двух файлов прошли. Первый общий npm test завершился с assertion failures/out-of-memory; последовательный retry — 3890passed/3failed/81skipped. TypeScript — 8 ошибок в новых accessibility tests соседних чатов. Общий gate красный. Это не завершение upload/download или whole issue; #34 остаётся «В работе». [Решения по доскам #4–#6](PROCESS_BOARDS_DECISIONS_2026-10-21.md) фиксируют самостоятельное создание отчётов с черновиками, ручной учёт отправки чеков и передачу/принятие без CRM-цикла.
