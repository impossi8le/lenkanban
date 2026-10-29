// @ts-check
const assert = require("node:assert/strict");
const {
  LEGACY_MUTATION_RED_TEST_TITLES,
  shouldSkipLegacyMutationTest,
} = require("./legacy-mutation.cjs");

const expectedBehavioralRedTitles = [
  "same-column order persists after reload",
  "keyboard drag announces Russian instructions and Escape restoration",
];
const unrelatedTitles = [
  "cross-column move and return persist exact order",
  "empty-column background accepts a task",
  "Escape restores the pre-drag order without a move request",
  "outside drop restores the pre-drag order without a move request",
  "click or tap move menu moves a task and restores useful focus",
  "drag handles are disabled by a filter and by non-position sort",
  "409 conflict rolls optimistic order back",
  "network failure rolls back and a deliberate retry succeeds",
  "successful movement has no console errors or failed move requests",
];

assert.deepEqual(
  [...LEGACY_MUTATION_RED_TEST_TITLES],
  expectedBehavioralRedTitles,
);
for (const testTitle of expectedBehavioralRedTitles) {
  assert.equal(
    shouldSkipLegacyMutationTest({
      dndV2Enabled: false,
      testTitle,
    }),
    false,
    `${testTitle} must execute as a behavioral legacy RED`,
  );
}
for (const testTitle of unrelatedTitles) {
  assert.equal(
    shouldSkipLegacyMutationTest({
      dndV2Enabled: false,
      testTitle,
    }),
    true,
    `${testTitle} must be skipped during the legacy mutation`,
  );
  assert.equal(
    shouldSkipLegacyMutationTest({
      dndV2Enabled: true,
      testTitle,
    }),
    false,
    `${testTitle} must remain enabled during the modern suite`,
  );
}

console.log("legacy mutation selection probes: OK");
