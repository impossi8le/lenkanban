const { test } = require("@playwright/test");

// Acceptance gaps are first-class skipped cases, never empty passing tests.
// Do not remove a skip until its prerequisites and verifiable assertions exist.
test.describe("#59 BLOCKED acceptance gaps", () => {
  // Registration, conditional realtime and membership regression have real
  // cases in their respective specs; duplicate skipped placeholders removed.
  // Remaining global-role/open-socket gaps are recorded in acceptance-status.json.
  // React render failure and its complete breadcrumb chain are an executable,
  // unskipped acceptance case in error-path-regression.spec.cjs.
  // Real local upload/download and revoked-member denial are now executable
  // without skip in collaboration.spec.cjs. Sink misconfiguration fails setup.
  test("logout resets telemetry session and no old batch crosses to another actor", async () => {
    test.skip(true, "BLOCKED: current logout spec verifies UI/auth revocation only. Needs a held telemetry batch, a second actor login and a deterministic client-disposal barrier; reload alone cannot prove telemetry reset.");
  });
});
