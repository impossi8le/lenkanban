// @ts-check
const assert = require("node:assert/strict");
const {
  runBestEffortCleanup,
} = require("./isolated-project.cjs");

async function main() {
  const calls = [];
  await assert.rejects(
    () =>
      runBestEffortCleanup([
        {
          label: "project",
          run: async () => {
            calls.push("project");
            throw new Error("project delete failed");
          },
        },
        {
          label: "user",
          run: async () => {
            calls.push("user");
          },
        },
        {
          label: "rate",
          run: async () => {
            calls.push("rate");
          },
        },
        {
          label: "disconnect",
          run: async () => {
            calls.push("disconnect");
            throw new Error("disconnect failed");
          },
        },
      ]),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
  assert.deepEqual(calls, [
    "project",
    "user",
    "rate",
    "disconnect",
  ]);
  console.log("best-effort cleanup probes: OK");
}

void main();
