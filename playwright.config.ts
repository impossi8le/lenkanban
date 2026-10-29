import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";
import safety from "./e2e/fixtures/safety.cjs";
import managedServer from "./e2e/fixtures/managed-server.cjs";

const {
  assertManagedServerBaseUrl,
  parseSafeBaseUrl,
  parseTestDatabaseUrl,
} = safety;
const parsedBaseUrl = parseSafeBaseUrl(
  process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3555",
);
const baseURL = parsedBaseUrl.url;

const usesExternalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === "1";
const serverMode = managedServer.selectManagedServerMode(process.env);
const usesBuiltServer = serverMode.usesBuiltServer;
// Realtime specs need the separate Socket.IO process. They are skipped with an
// explicit reason unless the caller opts in; the managed server never guesses.
const socketEnabled = process.env.E2E_SOCKET === "1";
const socketPort = "3556";
const socketHandshakeUrl =
  `http://127.0.0.1:${socketPort}/socket.io/?EIO=4&transport=polling`;
// Next.js and the socket process must sign the loopback bridge with one value.
const e2eInternalEmitSecret = randomBytes(32).toString("base64url");
const e2eDatabase = parseTestDatabaseUrl(
  process.env.E2E_DATABASE_URL,
);
const e2eNextAuthSecret =
  process.env.E2E_NEXTAUTH_SECRET ??
  randomBytes(32).toString("base64url");

if (!usesExternalServer) {
  assertManagedServerBaseUrl(parsedBaseUrl);
}

const visualMatch = "**/design-*.spec.cjs";
const updateBaselines = process.env.E2E_UPDATE_BASELINES === "1";
if (process.env.CI && updateBaselines) {
  throw new Error("Baseline updates require local review, never CI");
}
// #48 already specifies 320/390/1024. Opt in without expanding the default gate.
const visualWidths = process.env.E2E_VISUAL_EXTENDED === "1"
  ? [320, 360, 390, 768, 1024, 1440] : [360, 768, 1440];
const visualProjects = visualWidths.flatMap((width) =>
  (["light", "dark", "system-light", "system-dark"] as const).map((theme) => ({
    name: `visual-${width}-${theme}`,
    testMatch: visualMatch,
    metadata: { theme: theme.startsWith("system") ? "system" : theme },
    use: {
      browserName: "chromium" as const,
      viewport: { width, height: width === 320 ? 568 : width <= 390 ? 844 : width === 768 ? 1024 : width === 1024 ? 768 : 900 },
      deviceScaleFactor: 1,
      colorScheme: theme.endsWith("dark") ? "dark" as const : "light" as const,
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
      reducedMotion: "reduce" as const,
      serviceWorkers: "block" as const,
      // Login credentials must never enter traces/videos.
      trace: "off" as const,
      video: "off" as const,
      screenshot: "off" as const,
    },
  })),
);

export default defineConfig({
  testDir: "./e2e",
  testMatch: [
    "**/smoke.spec.cjs",
    "**/kanban-dnd-v2.spec.cjs",
    "**/dnd99-handle-opening.spec.cjs",
    "**/kanban-theme-accessibility.spec.cjs",
    "**/core-regression.spec.cjs",
    "**/error-path-regression.spec.cjs",
    "**/regression-blockers.spec.cjs",
    "**/auth-registration.spec.cjs",
    "**/collaboration.spec.cjs",
    "**/realtime.spec.cjs",
    visualMatch,
  ],
  updateSnapshots: updateBaselines ? "all" : "none",
  snapshotPathTemplate: "{testDir}/baselines/{projectName}/{testFilePath}/{arg}{ext}",
  expect: {
    toHaveScreenshot: {
      animations: "disabled", caret: "hide", scale: "css",
      threshold: 0, maxDiffPixels: 0,
    },
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  failOnFlakyTests: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  outputDir: "./e2e/artifacts/results",
  reporter: [["html", { open: "never", outputFolder: "e2e/artifacts/report" }]],

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium-desktop",
      testIgnore: visualMatch,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox-desktop",
      testIgnore: visualMatch,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit-desktop",
      testIgnore: visualMatch,
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "chromium-mobile",
      testIgnore: visualMatch,
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "webkit-mobile",
      testIgnore: visualMatch,
      use: { ...devices["iPhone 15"] },
    },
    ...visualProjects,
  ],

  webServer: usesExternalServer
    ? undefined
    : [
        {
          command: serverMode.command,
          url: baseURL,
          reuseExistingServer: false,
          timeout: serverMode.startupTimeout,
          env: {
            NODE_ENV: usesBuiltServer ? "production" : "development",
            HOSTNAME: "127.0.0.1",
            PORT: "3555",
            DATABASE_URL: e2eDatabase.url,
            NEXTAUTH_URL: baseURL,
            NEXTAUTH_SECRET: e2eNextAuthSecret,
            // Same-origin CORS and cookie validation for the socket process.
            APP_URL: baseURL,
            NEXT_PUBLIC_APP_URL: baseURL,
            // The registration scenario needs the confirmation step to be real.
            // Fixture users already have emailVerified, so they still sign in.
            EMAIL_VERIFICATION_REQUIRED: "true",
            LOCAL_AUTH_MODE: "open",
            ...(socketEnabled
              ? {
                  NEXT_PUBLIC_SOCKET_URL: `http://127.0.0.1:${socketPort}`,
                  SOCKET_PORT: socketPort,
                  INTERNAL_EMIT_SECRET: e2eInternalEmitSecret,
                }
              : {}),
          },
        },
        ...(socketEnabled
          ? [{
              // The production socket entry point, not a test double.
              command: "npx tsx src/socket/server.ts",
              url: socketHandshakeUrl,
              reuseExistingServer: false,
              timeout: 60_000,
              env: {
                DATABASE_URL: e2eDatabase.url,
                NEXTAUTH_URL: baseURL,
                APP_URL: baseURL,
                NEXT_PUBLIC_APP_URL: baseURL,
                PORT: "3555",
                SOCKET_PORT: socketPort,
                INTERNAL_EMIT_SECRET: e2eInternalEmitSecret,
              },
            }]
          : []),
      ],
});
