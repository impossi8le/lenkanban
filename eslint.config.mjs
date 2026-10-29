import { FlatCompat } from "@eslint/eslintrc";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Convert legacy `extends`-based configs (like eslint-config-next) to Flat Config.
const compat = new FlatCompat({
  baseDirectory: __dirname,
});

export default [
  // Next.js recommended rules
  ...compat.extends("next/core-web-vitals", "next/typescript"),

  // Node scripts/configs: relax a few TS-centric rules.
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "import/no-anonymous-default-export": "off",
    },
  },

  // Project ignores
  {
    ignores: [
      "node_modules/**",
      "lenkanban/**",
      ".board-work/**",
      ".mail-work/**",
      "Python/**",
      "output/**",
      "work/**",
      ".next/**",
      // Local Next build snapshots are generated output, like .next itself.
      ".next.*/**",
      "out/**",
      "build/**",
      "dist/**",
      "socket-runtime/dist/**",
      "next-env.d.ts",
    ],
  },
];
