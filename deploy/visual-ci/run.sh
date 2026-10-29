#!/usr/bin/env bash
set -euo pipefail
cd /build
mkdir -p e2e/artifacts
node /renderer/renderer.mjs /renderer/renderer.expected.json e2e/artifacts/renderer.json
node -e "require('./e2e/fixtures/safety.cjs').parseTestDatabaseUrl(process.env.E2E_DATABASE_URL)"
npm ci --include=dev
node -e "if(require('@playwright/test/package.json').version!=='1.58.2')throw Error('Playwright lock drift')"
if [[ "${VISUAL_CI_CAPTURE:-0}" != 1 ]]; then node deploy/visual-ci/coverage.cjs; fi
NODE_ENV=production npm run build
node scripts/runtime-image.mjs .next/standalone
node node_modules/@playwright/test/cli.js test --config=deploy/visual-ci/playwright.config.ts --project='visual-*'
if [[ "${VISUAL_CI_CAPTURE:-0}" == 1 ]]; then node deploy/visual-ci/coverage.cjs e2e/artifacts/provisional-baselines; fi
