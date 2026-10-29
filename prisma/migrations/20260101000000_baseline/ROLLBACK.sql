-- Откат baseline-миграции 20260101000000_baseline.
--
-- Baseline — это свёрнутый снимок всей схемы, поэтому откат удаляет схему
-- целиком. ВНИМАНИЕ: скрипт уничтожает ВСЕ данные в схеме public, включая
-- таблицу истории _prisma_migrations. Применять только к БД, которую нужно
-- вернуть в пустое состояние (например, при повторной проверке установки).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ROLLBACK.sql
--
-- После отката БД пуста; для повторной установки снова выполнить
-- `npx prisma migrate deploy`.

DROP SCHEMA IF EXISTS "public" CASCADE;
CREATE SCHEMA "public";

-- Восстановить права по умолчанию для текущего владельца БД.
GRANT ALL ON SCHEMA "public" TO CURRENT_USER;
