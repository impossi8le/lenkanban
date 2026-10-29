// @ts-check
const assert = require("node:assert/strict");
const {
  assertManagedServerBaseUrl,
  assertLoopbackBaseUrl,
  parseSafeBaseUrl,
  parseTestDatabaseUrl,
} = require("./safety.cjs");

function rejects(operation, pattern) {
  assert.throws(operation, pattern);
}

const localBase = parseSafeBaseUrl("http://127.0.0.1:3555");
assert.equal(localBase.hostname, "127.0.0.1");
assert.equal(assertLoopbackBaseUrl(localBase).hostname, "127.0.0.1");
assert.equal(
  assertManagedServerBaseUrl(localBase).url,
  "http://127.0.0.1:3555/",
);
for (const managedServerMismatch of [
  "http://127.0.0.1:3556",
  "https://127.0.0.1:3555",
  "http://localhost:3555",
  "http://127.0.0.2:3555",
]) {
  rejects(
    () =>
      assertManagedServerBaseUrl(
        parseSafeBaseUrl(managedServerMismatch),
      ),
    /managed|127\.0\.0\.1:3555|origin/i,
  );
}
assert.equal(
  assertLoopbackBaseUrl(parseSafeBaseUrl("http://LOCALHOST.:3555"))
    .hostname,
  "localhost",
);
assert.equal(
  assertLoopbackBaseUrl(parseSafeBaseUrl("http://[::1]:3555"))
    .hostname,
  "::1",
);
assert.equal(
  parseSafeBaseUrl("https://KANBAN.LENREMONTN8N.RU.evil.test").hostname,
  "kanban.lenremontn8n.ru.evil.test",
);

for (const unsafeBaseUrl of [
  "not a URL",
  "ftp://127.0.0.1:3555",
  "https://kanban.lenremontn8n.ru",
  "https://KANBAN.LENREMONTN8N.RU:443",
  "https://kanban.lenremontn8n.ru.",
  "https://preview.kanban.lenremontn8n.ru",
  "https://preview%2Ekanban%2Elenremontn8n%2Eru",
]) {
  rejects(
    () => parseSafeBaseUrl(unsafeBaseUrl),
    /PLAYWRIGHT_BASE_URL|production|http/i,
  );
}

for (const nonLoopbackUrl of [
  "https://staging.example.test",
  "http://0.0.0.0:3555",
  "http://192.168.1.10:3555",
]) {
  rejects(
    () => assertLoopbackBaseUrl(parseSafeBaseUrl(nonLoopbackUrl)),
    /loopback/i,
  );
}

const postgres = parseTestDatabaseUrl(
  "postgresql://user:password@127.0.0.1:5432/kanban_test?schema=public",
);
assert.equal(postgres.databaseName, "kanban_test");
assert.equal(
  parseTestDatabaseUrl(
    "postgres://user:password@127.0.0.1:5432/%6banban_test",
  ).databaseName,
  "kanban_test",
);

for (const unsafeDatabaseUrl of [
  undefined,
  "not a URL",
  "mysql://user:password@127.0.0.1:3306/kanban_test",
  "https://127.0.0.1/kanban_test",
  "postgresql://user:password@127.0.0.1:5432/kanban",
  "postgresql://user:password@127.0.0.1:5432/kanban_test_backup",
  "postgresql://user:password@127.0.0.1:5432/",
  "postgresql://user:password@127.0.0.1:5432/kanban_test/",
  "postgresql://user:password@127.0.0.1:5432/archive/kanban_test",
  "postgresql://user:password@127.0.0.1:5432/archive%2Fkanban_test",
  "postgresql://user:password@127.0.0.1:5432/archive%5Ckanban_test",
]) {
  rejects(
    () => parseTestDatabaseUrl(unsafeDatabaseUrl),
    /E2E_DATABASE_URL|PostgreSQL|database/i,
  );
}

console.log("shared E2E safety probes: OK");
