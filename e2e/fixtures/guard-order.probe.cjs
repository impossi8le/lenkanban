// @ts-check
const assert = require("node:assert/strict");
const Module = /** @type {any} */ (require("node:module"));
const realSafety = require("./safety.cjs");

const fixturePath = require.resolve("./isolated-project.cjs");
const originalLoad = Module._load;
const previousDatabaseUrl = process.env.DATABASE_URL;
const events = [];

try {
  delete require.cache[fixturePath];
  Module._load = function loadWithPrismaTrap(
    request,
    parent,
    isMain,
  ) {
    if (
      request === "./safety.cjs" &&
      parent?.filename === fixturePath
    ) {
      return {
        ...realSafety,
        parseTestDatabaseUrl(rawUrl) {
          events.push("guard-call");
          return realSafety.parseTestDatabaseUrl(rawUrl);
        },
      };
    }
    if (request === "@prisma/client") {
      events.push("prisma-require");
      assert.equal(
        events[0],
        "guard-call",
        "The real DB guard call must happen before Prisma is required",
      );
      return {
        PrismaClient: class PrismaClientTrap {
          constructor() {
            events.push("prisma-construct");
          }
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const { loadPrismaClient } = require(fixturePath);
  assert.equal(
    typeof loadPrismaClient,
    "function",
    "The fixture must expose its guarded loader to the probe",
  );

  events.length = 0;
  assert.throws(
    () =>
      loadPrismaClient(
        "mysql://e2e:e2e@127.0.0.1:3306/kanban_test",
      ),
    /postgres|protocol/i,
  );
  assert.deepEqual(
    events,
    ["guard-call"],
    "An unsafe URL must be rejected without requiring Prisma",
  );

  events.length = 0;
  loadPrismaClient(
    "postgresql://e2e:e2e@127.0.0.1:5432/kanban_test",
  );
  assert.deepEqual(events, [
    "guard-call",
    "prisma-require",
    "prisma-construct",
  ]);
} finally {
  Module._load = originalLoad;
  delete require.cache[fixturePath];
  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }
}

console.log("runtime DB guard-before-Prisma probe: OK");
