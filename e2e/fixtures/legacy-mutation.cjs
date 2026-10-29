// @ts-check

const LEGACY_MUTATION_RED_TEST_TITLES = Object.freeze([
  "same-column order persists after reload",
  "keyboard drag announces Russian instructions and Escape restoration",
]);
const LEGACY_MUTATION_RED_TEST_TITLE_SET = new Set(
  LEGACY_MUTATION_RED_TEST_TITLES,
);

/**
 * @param {{ dndV2Enabled: boolean, testTitle: string }} input
 */
function shouldSkipLegacyMutationTest(input) {
  return (
    !input.dndV2Enabled &&
    !LEGACY_MUTATION_RED_TEST_TITLE_SET.has(input.testTitle)
  );
}

module.exports = {
  LEGACY_MUTATION_RED_TEST_TITLES,
  shouldSkipLegacyMutationTest,
};
