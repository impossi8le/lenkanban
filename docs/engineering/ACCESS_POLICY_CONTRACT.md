# Общая политика доступа: совместимый legacy-срез

21.10.2026, #16. Контракт закреплён до зависимого кода волны11. Это первый исполнимый слой объяснения текущих project capabilities; scoped profiles, OWN/private/internal и новые права он не включает.

Дополнение волны12: [предварительный круг заявителей](PROJECT_APPLICANT_POLICY_CONTRACT.md) использует отдельный pure evaluateProjectApplicantPolicy в том же модуле. Он не меняет evaluateLegacyProjectAccess/getProjectAccess и не включает enforcement старого Task create; authoritative ADMIN preview читает сохранённую policy и свежие subjectfacts через sharedreader.

## Один evaluator и существующий adapter

`src/lib/access-policy.ts` экспортирует чистый `evaluateLegacyProjectAccess(actor, project)` и закрытые типы. Actor: readonly `{id: string, globalRole: 'USER' | 'ADMIN'}`. Project: readonly `{ownerId: string, membershipRole: 'MEMBER' | 'PROJECT_ADMIN' | null}` либо null (нет загруженных фактов проекта). Только установленные сервером факты; это не валидатор клиентских payload или JWT и не самостоятельная проверка свежести identity.

Результат содержит `canRead`, `canWrite`, `canManageMembers`, каждый как `{allowed: boolean, source: LegacyProjectAccessSource}`. Закрытый source: `global_admin | project_owner | project_admin | project_member | no_project_access`. Это причина конкретного решения, включая отказ member в управлении составом. Детерминированный приоритет: global ADMIN → owner → PROJECT_ADMIN → MEMBER → no_project_access. Выбирается один подтверждённый источник, перечень всех совмещённых ролей не обещается. ADMIN без запроса проекта не получает выдуманных owner/member sources.

| Проверенные факты | Read | Write | Manage members | Source |
| --- | --- | --- | --- | --- |
| ADMIN, любые/не загруженные project facts | true | true | true | global_admin |
| USER, найденный project.ownerId = actor.id | true | true | true | project_owner |
| USER, membership PROJECT_ADMIN | true | true | true | project_admin |
| USER, membership MEMBER | true | true | false | project_member для всех трёх решений |
| USER, нет проекта или membership/ownership | false | false | false | no_project_access |

Нет сети/БД/логирования/побочных эффектов и мутации входных объектов. Выход каждого вызова независим. Произвольные дополнительные orgmetadata, names, permission strings не являются входными grants. Типы закрыты для уже нормализованных DB enum; runtime обработка недоверенных/неизвестных enum не заявляется.

`src/lib/project-access.ts` остаётся единственным существующим DB adapter. getProjectAccess/user/projectId/database и ProjectAccess DTO сохраняются: ровно projectId и три boolean, без новых полей в HTTP/SSR. Adapter использует evaluator для всех результатов. ADMIN fast path по-прежнему не читает project и разрешает даже несуществующий projectId; исправление этой исторической семантики требует отдельной задачи. Для остальных прежний findUnique/select owner + одна membership, injected transaction/default prisma, ошибки БД без успешного fallback. requireProjectRead/Write/MemberAdmin сохраняют NotFound и прежние сигнатуры.

Caller устанавливает свежую identity; helper сам её не перечитывает. Канонический checklist caller продолжает fresh actor после resource locks и перед receipt replay, передаёт тот же tx. Извлечение evaluator не добавляет новую auth query и не ослабляет существующий порядок.

## Уточнение #93: явно настроенная ответственная группа, 23.10.2026

Для board discovery/GET/SSR активное членство в **явно привязанной**
ResponsibleGroup даёт только `canRead`. Это принятое уточнение заменяет прежнее
описание orgmetadata как исключительно неактивной для этого одного READ случая.
`ProjectMember` не является ответственной группой; никакого backfill, повышения
ролей или выдачи write/manage из group membership нет. Группа с archivedAt != null,
отсутствующая связь и несовпадающий userId не дают этого права.

Чистый `projectReadPredicate` переиспользуется каталогом, GET проекта и обычным
GET колонок: ADMIN → legacy owner/member → active configured group. В адаптер
`getProjectAccess` передаются только загруженные через тот же tx факты группы и
ограниченное членство текущего пользователя. `evaluateProjectAccess` получает
отдельный нормализованный boolean; source нового READ решения —
`responsible_group_read`. `evaluateLegacyProjectAccess`, canWrite и canManageMembers
сохраняют прежнюю семантику. Сочетание с legacy правами не отменяет их.

Доступ к доске не раскрывает все заявки: списки, поиск и `_count.tasks` продолжают
использовать обязательный `getTaskReadWhere`. Ответственная группа видит чужие
отправленные заявки, но не личные DRAFT/удалённые заявки; broad board predicate
не используется вместо task predicate. Непосредственные изменения заявки
проверяются task/lifecycle механизмом, а не новым board READ grant. Каталог
показывает только ограниченные этим reader counts. Успех unit/route с моками
не является real PostgreSQL/runtime приёмкой.

## Следующие активации и запреты

Org Department/leader/primaryDepartment/ResponsibleGroup/projectbindings остаются metadata, не grants. Не мигрировать creator/assignee/legacy roles догадками. Read не означает submit/assign/status/internal/export; нынешний coarse canWrite совместим только с legacy caller, его нельзя использовать как новую матрицу lifecycle.

Scoped profiles требуют authoritative persisted scope/grant facts, явной precedence/inheritance и управления ими через существующий аудируемый сервис. OWN/private/internal включаются только после единой фильтрации HTTP/list/search/history/count/export/files/socket/notifications и отзыва на открытых соединениях. Этот срез не объявляет отдельные старые socket/where-clause политики исправленными. Источники и границы: work/validation/wave10-next-policy-scout-2026-10-21.md, REQUEST_LIFECYCLE.md, live #16/#17/#18/#65/#66.

## Приёмка и владение

Матрица выше, пересечения ролей, frozen input/independent output, отсутствие org grants; adapter ADMIN zero-query/missing project/denied wrappers/query errors/injected tx. Реальный checklist caller с новым adapter должен сохранить fresh auth до replay и отказ без mutation. Unit mocks не доказывают PostgreSQL или все каналы. Новая UI/schema/migration/реальная смена доступа этой волной не нужна.

Root: контракт, интеграция, независимые проверки/отчёт. backlog_dependencies: только access-policy.ts/project-access.ts. testing_foundation: новые access-policy.test.ts/project-access.policy.test.ts. logging_foundation: read-only review и следующий bounded scout. Старые project-access.organization.test.ts/checklist-toggle tests не менять без найденного дефекта и согласования владельца.
