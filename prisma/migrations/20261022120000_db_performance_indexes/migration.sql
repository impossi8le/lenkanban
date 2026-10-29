-- Индексы под профилированные запросы: список досок, доска задач, аналитика,
-- просрочки, поиск пользователей и keyset админки.
--
-- GIN-индекс по "ChatMessage"."readBy" СОЗНАТЕЛЬНО НЕ добавлен, хотя профиль его
-- предлагал. Оба места чтения используют отрицание оператора существования:
--   src/app/api/tasks/route.ts:180              -> AND NOT ("readBy" ? $1)
--   src/app/api/tasks/[id]/messages/read/route.ts:59 -> AND NOT ("readBy" ? $1)
-- В PostgreSQL нет GIN-класса операторов для отрицания `?`, поэтому такой индекс
-- не может обслужить ни один из запросов. `/api/messages/unread` вообще не
-- передаёт предикат в SQL: он выбирает строки и фильтрует их в JavaScript.
-- Индекс дал бы только стоимость записи. Возвращаться к вопросу, когда появится
-- положительный `"readBy" ? $1`, либо после перехода на таблицу отметок о
-- прочтении.
--
-- Все индексы аддитивны и не меняют данные. Ни один не дублирует существующие:
-- (projectId, columnId, position) не покрывает ORDER BY position без равенства
-- по columnId, поэтому (projectId, position) добавлен отдельно.
--
-- ПОЧЕМУ БЕЗ CONCURRENTLY
-- `CREATE INDEX` берёт SHARE-блокировку таблицы: читатели не блокируются,
-- запись (INSERT/UPDATE/DELETE) ждёт завершения построения. `CONCURRENTLY`
-- пишет без такой блокировки, но не может выполняться внутри транзакции, а
-- `prisma migrate deploy` оборачивает каждый файл миграции в транзакцию, и
-- Prisma не предоставляет способа выйти из неё. Поэтому здесь обычный
-- `CREATE INDEX` — миграция применится одной транзакцией на пустой/небольшой
-- базе и при обычном деплое. Для большой рабочей таблицы применять так:
--   1) выполнить блок «РУЧНОЙ ПУТЬ ДЛЯ БОЛЬШИХ ТАБЛИЦ» ниже вручную (psql,
--      без BEGIN — весь блок вне транзакции);
--   2) `prisma migrate resolve --applied 20261022120000_db_performance_indexes`,
--      чтобы не запускать этот файл повторно.
-- `CREATE INDEX CONCURRENTLY` при сбое оставляет INVALID-индекс: его надо
-- удалить (`DROP INDEX`) и повторить, иначе планировщик его проигнорирует.
--
-- ОТКАТ (в обратном порядке; безопасен, данные не затрагивает):
--   DROP INDEX IF EXISTS "User_email_gin_idx";
--   DROP INDEX IF EXISTS "User_name_gin_idx";
--   DROP INDEX IF EXISTS "User_createdAt_id_idx";
--   DROP INDEX IF EXISTS "Task_deadline_idx";
--   DROP INDEX IF EXISTS "Task_priority_idx";
--   DROP INDEX IF EXISTS "Task_status_idx";
--   DROP INDEX IF EXISTS "Task_projectId_position_idx";
--   DROP INDEX IF EXISTS "Project_updatedAt_idx";
--   DROP INDEX IF EXISTS "Project_ownerId_idx";
-- Расширение pg_trgm не удаляем: оно уже создано baseline-миграцией и может
-- использоваться другими индексами (Task_title_gin_idx, Project_name_gin_idx).

-- pg_trgm уже создан в baseline; повтор безопасен (IF NOT EXISTS).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Список досок: OR[{ ownerId }, { members.some }] + ORDER BY updatedAt DESC.
-- ownerId — равенство в OR-ветке; updatedAt — порядок выдачи и «топ-6» на главной.
CREATE INDEX "Project_ownerId_idx" ON "Project"("ownerId");
CREATE INDEX "Project_updatedAt_idx" ON "Project"("updatedAt");

-- Доска: WHERE "projectId" = $1 ORDER BY "position" ASC.
-- Существующий (projectId, columnId, position) требует равенства по columnId,
-- иначе PostgreSQL не может использовать его для сортировки по position.
CREATE INDEX "Task_projectId_position_idx" ON "Task"("projectId", "position");

-- Аналитика: groupBy(status) и groupBy(priority); счётчики status != 'DONE'.
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_priority_idx" ON "Task"("priority");

-- Просрочки: "status" != 'DONE' AND "deadline" < now().
-- Отдельный индекс по deadline даёт диапазонный скан; составной (status, deadline)
-- здесь хуже, потому что status != 'DONE' — не равенство.
CREATE INDEX "Task_deadline_idx" ON "Task"("deadline");

-- Поиск пользователей: ILIKE '%q%' по name и email (/api/users, /api/admin/users).
CREATE INDEX "User_name_gin_idx" ON "User" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "User_email_gin_idx" ON "User" USING GIN ("email" gin_trgm_ops);

-- Keyset админки: ORDER BY "createdAt" DESC, "id" DESC (тип и id в одном индексе).
CREATE INDEX "User_createdAt_id_idx" ON "User"("createdAt", "id");

-- ---------------------------------------------------------------------------
-- РУЧНОЙ ПУТЬ ДЛЯ БОЛЬШИХ ТАБЛИЦ (не выполнять через Prisma; вне транзакции):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "Project_ownerId_idx" ON "Project"("ownerId");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "Project_updatedAt_idx" ON "Project"("updatedAt");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "Task_projectId_position_idx" ON "Task"("projectId", "position");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "Task_status_idx" ON "Task"("status");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "Task_priority_idx" ON "Task"("priority");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "Task_deadline_idx" ON "Task"("deadline");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_name_gin_idx" ON "User" USING GIN ("name" gin_trgm_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_email_gin_idx" ON "User" USING GIN ("email" gin_trgm_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_createdAt_id_idx" ON "User"("createdAt", "id");
--
-- Затем: npx prisma migrate resolve --applied 20261022120000_db_performance_indexes
-- ---------------------------------------------------------------------------
