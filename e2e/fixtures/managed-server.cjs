const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

/** @param {Record<string, string | undefined>} env */
function selectManagedServerMode(env) {
  const prebuilt = env.E2E_PRODUCTION_SERVER === '1';
  const buildBeforeStart = Boolean(env.CI) && !prebuilt;
  const usesBuiltServer = prebuilt || Boolean(env.CI);
  return {
    usesBuiltServer,
    buildBeforeStart,
    command: usesBuiltServer
      ? 'node scripts/start-built-e2e.mjs' + (buildBeforeStart ? ' --build' : '')
      : 'node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3555',
    startupTimeout: buildBeforeStart ? 600_000 : 120_000,
  };
}

function parseBuiltArguments(args) {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === '--build') return true;
  throw new Error('Built E2E startup accepts only optional --build');
}

/** Clear database, authentication, emission, mail and Sentry environment keys before build. */
function buildEnvironment(runtime) {
  const env = { ...runtime };
  for (const key of Object.keys(env)) {
    if (/DATABASE|^DB_|^PG[A-Z_]+$|^DIRECT_URL$|SENTRY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY|^SMTP_|^MAIL_|^EMAIL_/i.test(key)) env[key] = '';
  }
  for (const key of ['DATABASE_URL', 'E2E_DATABASE_URL', 'TEST_DATABASE_URL', 'PRODUCTION_DATABASE_URL', 'DIRECT_URL', 'SHADOW_DATABASE_URL', 'SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN', 'SENTRY_AUTH_TOKEN', 'NEXTAUTH_SECRET', 'E2E_NEXTAUTH_SECRET', 'AUTH_SECRET', 'INTERNAL_EMIT_SECRET']) env[key] = '';
  env.NODE_ENV = 'production';
  env.NEXT_TELEMETRY_DISABLED = '1';
  env.APP_URL = runtime.NEXTAUTH_URL;
  env.NEXT_PUBLIC_APP_URL = runtime.NEXTAUTH_URL;
  env.NEXT_PUBLIC_SOCKET_URL = runtime.NEXT_PUBLIC_SOCKET_URL ?? '';
  return env;
}

function prepareBuiltE2E({ args, env, root, spawn = spawnSync, exists = fs.existsSync, execPath = process.execPath, emit = value => console.info('[e2e-server] ' + JSON.stringify(value)) }) {
  const buildBeforeStart = parseBuiltArguments(args);
  emit({ phase: 'mode', mode: 'compiled', buildBeforeStart });
  if (!buildBeforeStart) return;
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    if (exists(path.join(root, name))) throw new Error('Compiled E2E build refuses Next environment files');
  }
  const npmCandidates = [env.npm_execpath, path.join(path.dirname(execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const npm = npmCandidates.find(candidate => typeof candidate === 'string' && path.basename(candidate) === 'npm-cli.js' && exists(candidate));
  if (!npm) throw new Error('Installed npm CLI required for compiled E2E build');
  emit({ phase: 'build-start' });
  const result = spawn(execPath, [npm, 'run', 'build'], { cwd: root, env: buildEnvironment(env), stdio: 'inherit', windowsHide: true });
  if (result.error || result.signal || result.status !== 0) {
    emit({ phase: 'build-failed', exit: Number.isInteger(result.status) ? result.status : null, timedOut: result.error?.code === 'ETIMEDOUT' });
    throw new Error('Compiled E2E build failed before server startup');
  }
  emit({ phase: 'build-complete', exit: 0 });
}

module.exports = { selectManagedServerMode, parseBuiltArguments, buildEnvironment, prepareBuiltE2E };
