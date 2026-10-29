-- Read-only проверка схемы taskboard после `prisma migrate deploy`.
-- Запуск (см. deploy/DB_BOOTSTRAP_TASKBOARD.md):
--   docker compose -p taskboard exec -T db sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
--     < deploy/sql/verify_taskboard_schema.sql
--
-- Скрипт ничего не изменяет. При отсутствии любого ожидаемого объекта
-- завершается ошибкой (ON_ERROR_STOP=1 + RAISE EXCEPTION).

\set ON_ERROR_STOP on

DO $$
DECLARE
    missing text[] := ARRAY[]::text[];
BEGIN
    -- Ключевые таблицы (полный набор создаётся baseline).
    IF to_regclass('public."User"') IS NULL THEN missing := array_append(missing, 'table User'); END IF;
    IF to_regclass('public."Project"') IS NULL THEN missing := array_append(missing, 'table Project'); END IF;
    IF to_regclass('public."Task"') IS NULL THEN missing := array_append(missing, 'table Task'); END IF;
    IF to_regclass('public."TaskRequest"') IS NULL THEN missing := array_append(missing, 'table TaskRequest'); END IF;
    IF to_regclass('public."TaskWatcher"') IS NULL THEN missing := array_append(missing, 'table TaskWatcher'); END IF;
    IF to_regclass('public."ScopedPrivilegeAssignment"') IS NULL THEN missing := array_append(missing, 'table ScopedPrivilegeAssignment'); END IF;

    -- CHECK-ограничения, которые Prisma не выражает в datamodel.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScopedPrivilegeAssignment_scope_shape_check')
        THEN missing := array_append(missing, 'check ScopedPrivilegeAssignment_scope_shape_check'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TaskRequest_contract_version_check')
        THEN missing := array_append(missing, 'check TaskRequest_contract_version_check'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TaskRequest_executor_shape_check')
        THEN missing := array_append(missing, 'check TaskRequest_executor_shape_check'); END IF;

    -- Частичные уникальные индексы.
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ScopedPrivilegeAssignment_organization_unique')
        THEN missing := array_append(missing, 'index ScopedPrivilegeAssignment_organization_unique'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ScopedPrivilegeAssignment_department_unique')
        THEN missing := array_append(missing, 'index ScopedPrivilegeAssignment_department_unique'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ScopedPrivilegeAssignment_board_unique')
        THEN missing := array_append(missing, 'index ScopedPrivilegeAssignment_board_unique'); END IF;

    -- Поисковые GIN-индексы и частичный индекс непрочитанных сообщений.
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'Task_title_gin_idx')
        THEN missing := array_append(missing, 'index Task_title_gin_idx'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'Task_description_gin_idx')
        THEN missing := array_append(missing, 'index Task_description_gin_idx'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'Project_name_gin_idx')
        THEN missing := array_append(missing, 'index Project_name_gin_idx'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ChatMessage_taskId_readBy_idx')
        THEN missing := array_append(missing, 'index ChatMessage_taskId_readBy_idx'); END IF;

    -- Ключевые уникальные индексы канонической схемы.
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'Task_projectId_columnId_rank_key')
        THEN missing := array_append(missing, 'index Task_projectId_columnId_rank_key'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ProjectColumn_projectId_workflowKey_key')
        THEN missing := array_append(missing, 'index ProjectColumn_projectId_workflowKey_key'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'User_externalId_key')
        THEN missing := array_append(missing, 'index User_externalId_key'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'TaskWatcher_taskId_userId_key')
        THEN missing := array_append(missing, 'index TaskWatcher_taskId_userId_key'); END IF;

    -- Расширение для trigram-поиска.
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')
        THEN missing := array_append(missing, 'extension pg_trgm'); END IF;

    -- Bytewise-сравнение рангов: collation "C" у Task.rank.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute a
        JOIN pg_collation c ON c.oid = a.attcollation
        WHERE a.attrelid = to_regclass('public."Task"')
          AND a.attname = 'rank'
          AND c.collname = 'C'
    ) THEN missing := array_append(missing, 'collation C on Task.rank'); END IF;

    -- Baseline должен быть применён и завершён.
    IF to_regclass('public._prisma_migrations') IS NULL THEN
        missing := array_append(missing, 'applied migration 20260101000000_baseline');
    ELSIF NOT EXISTS (
        SELECT 1 FROM _prisma_migrations
        WHERE migration_name = '20260101000000_baseline' AND finished_at IS NOT NULL
    ) THEN
        missing := array_append(missing, 'applied migration 20260101000000_baseline');
    END IF;

    IF array_length(missing, 1) IS NOT NULL THEN
        RAISE EXCEPTION 'schema verification failed: %', array_to_string(missing, ', ');
    END IF;

    RAISE NOTICE 'schema verification OK';
END $$;

SELECT 'tables' AS metric, count(*)::text AS value
FROM information_schema.tables WHERE table_schema = 'public'
UNION ALL
SELECT 'public CHECK constraints', count(*)::text
FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace
UNION ALL
SELECT 'custom indexes', count(*)::text
FROM pg_indexes WHERE schemaname = 'public'
  AND indexname IN (
    'Task_title_gin_idx','Task_description_gin_idx','Project_name_gin_idx',
    'ChatMessage_taskId_readBy_idx',
    'ScopedPrivilegeAssignment_organization_unique',
    'ScopedPrivilegeAssignment_department_unique',
    'ScopedPrivilegeAssignment_board_unique'
  );
