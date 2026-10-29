-- Explicit opt-in configuration. Existing boards remain unconfigured.
ALTER TABLE "Project" ADD COLUMN "lifecycleColumnMap" JSONB;
