import path from "node:path";
import root from "../playwright.config";

// Keep the root safety guards and managed-server configuration. Absolute paths
// prevent relocating testDir when this config is loaded from e2e/.
const config = {
  ...root,
  testDir: path.resolve(__dirname),
  outputDir: path.resolve(__dirname, "artifacts/results"),
  updateSnapshots: "none" as const,
  retries: 0,
  reporter: [
    ["html", { open: "never", outputFolder: "e2e/artifacts/report" }],
    ["json", { outputFile: "e2e/artifacts/results.json" }],
  ] as NonNullable<typeof root.reporter>,
};

export default config;
