import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // Bound memory while browser/build workers run alongside the full suite.
    maxWorkers: 4,
    setupFiles: ["src/test/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    coverage: { reporter: ["text", "json-summary"] },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          exclude: [
            ...configDefaults.exclude,
            "lenkanban/**",
            "work/**",
            ".next/**",
            // Scratch area: holds throwaway checkouts (e.g. the publication clone).
            ".board-work/**",
            // These suites use node:test; run them with npm run test:mail.
            "tests/mail/**",
            // deploy/ suites use node:test: run them with `node --test deploy/*.test.mjs`.
            "deploy/**",
            "**/*.component.test.tsx",
            "**/use-kanban-dnd.test.tsx",
            "e2e/**",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          // Component suites mount the real client tree; under full parallel load the
          // default 5s budget is not enough for setup+render.
          testTimeout: 20000,
          include: [
            "**/*.component.test.tsx",
            "**/use-kanban-dnd.test.tsx",
          ],
          exclude: [...configDefaults.exclude, "lenkanban/**", "work/**", ".next/**", ".board-work/**"],
        },
      },
    ],
  },
});
