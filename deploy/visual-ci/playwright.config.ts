import path from "node:path";
import config from "../../e2e/playwright.ci.config";

const capture = process.env.VISUAL_CI_CAPTURE === "1";
if (capture && (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.E2E_CI_UPDATE_BASELINES !== "1")) throw Error("Explicit manual capture required");
const projects = config.projects?.filter(project => /^visual-(360|768|1440)-(light|dark|system-light|system-dark)$/.test(project.name ?? ""));
if (projects?.length !== 12) throw Error("Canonical visual project inventory mismatch");
export default {
  ...config, testDir: path.resolve(__dirname, "../../e2e"), projects,
  testMatch: ["**/design-screens.spec.cjs", "**/design-states.spec.cjs"],
  updateSnapshots: capture ? "all" as const : "none" as const,
  snapshotPathTemplate: capture
    ? path.resolve(__dirname, "../../e2e/artifacts/provisional-baselines/{projectName}/{testFilePath}/{arg}{ext}")
    : "{testDir}/baselines/{projectName}/{testFilePath}/{arg}{ext}",
  retries: 0, workers: 1, fullyParallel: false, maxFailures: 1,
};
