#!/usr/bin/env node
/**
 * Development launcher: runs Next.js and the Socket.IO server together.
 *
 * Both children inherit the parent environment (including TMPDIR), are stopped
 * together on Ctrl+C/SIGTERM, and a busy socket port fails fast with an
 * actionable Russian message instead of an endless client reconnect loop.
 *
 * Usage:
 *   npm run dev
 *   npm run dev -- --hostname localhost --port 3555
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const DEFAULT_SOCKET_PORT = 3556;

function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const values = {};
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

const envFile = path.join(root, ".env");
const fileEnv = readEnvFile(envFile);

function parsePort(raw, fallback) {
  const value = Number(String(raw ?? "").trim());
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : fallback;
}

const socketPort = parsePort(process.env.SOCKET_PORT ?? fileEnv.SOCKET_PORT, DEFAULT_SOCKET_PORT);

function devEnvironment() {
  const env = { ...process.env };
  // Both processes must see the same temp directory. Only fill gaps so a
  // Windows-native TEMP/TMP is never replaced with a POSIX-style TMPDIR.
  const tmpDir = env.TMPDIR?.trim();
  if (tmpDir) {
    env.TMPDIR = tmpDir;
    env.TEMP = env.TEMP || tmpDir;
    env.TMP = env.TMP || tmpDir;
  }
  return env;
}

function printPortBusy() {
  const lines = [
    "",
    `[dev] Ошибка: порт ${socketPort} уже занят другим процессом.`,
    "[dev] Socket.IO не запустился, поэтому realtime-обновления в интерфейсе работать не будут.",
    "[dev] Освободите порт и повторите запуск:",
    `[dev]   Windows:  netstat -ano | findstr :${socketPort}   затем  taskkill /PID <PID> /F`,
    `[dev]   macOS/Linux:  lsof -i :${socketPort}`,
    "[dev] Либо задайте другой SOCKET_PORT в .env и тот же порт в NEXT_PUBLIC_SOCKET_URL.",
    "",
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
}

function isPortBusy(port, host = "127.0.0.1") {
  return new Promise(resolve => {
    const probe = net.createConnection({ host, port });
    const finish = (busy) => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(busy);
    };
    probe.setTimeout(1500, () => finish(false));
    probe.once("connect", () => finish(true));
    probe.once("error", () => finish(false));
  });
}

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

if (!existsSync(nextBin) || !existsSync(tsxCli)) {
  process.stderr.write(
    "[dev] Ошибка: не найдены Next.js или tsx в node_modules. Выполните npm ci.\n",
  );
  process.exit(1);
}

if ((await isPortBusy(socketPort)) || (await isPortBusy(socketPort, "::1"))) {
  printPortBusy();
  process.exit(1);
}

const nextArgs = [nextBin, "dev", ...process.argv.slice(2)];
const socketArgs = [];
if (existsSync(envFile)) socketArgs.push(`--env-file=${envFile}`);
socketArgs.push(tsxCli, "watch", "src/socket/server.ts");

const children = [];
let shuttingDown = false;
let portBusyReported = false;

function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // taskkill /T also stops the processes Next.js and tsx watch spawn.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5000,
    });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // The child may have exited between the state check and the signal.
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) terminate(child);
  process.exit(code);
}

function launch(label, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env: devEnvironment(),
    stdio: label === "socket" ? ["inherit", "inherit", "pipe"] : "inherit",
    windowsHide: false,
  });
  children.push(child);

  child.once("error", error => {
    process.stderr.write(`[dev] Не удалось запустить ${label}: ${error.message}\n`);
    shutdown(1);
  });

  if (label === "socket" && child.stderr) {
    let tail = "";
    child.stderr.on("data", chunk => {
      process.stderr.write(chunk);
      tail = `${tail}${chunk.toString("utf8")}`.slice(-8192);
      if (!portBusyReported && /EADDRINUSE|address already in use/i.test(tail)) {
        portBusyReported = true;
        printPortBusy();
      }
    });
  }

  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stderr.write(
      `[dev] Процесс ${label} завершился (${signal ?? `код ${code}`}). Останавливаю остальные.\n`,
    );
    shutdown(code ?? 1);
  });

  return child;
}

process.stdout.write(
  `[dev] Next.js: npm run dev ${process.argv.slice(2).join(" ")}`.trimEnd() + "\n",
);
process.stdout.write(`[dev] Socket.IO: порт ${socketPort}\n`);

launch("next", process.execPath, nextArgs);
launch("socket", process.execPath, socketArgs);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!shuttingDown) process.stdout.write("\n[dev] Останавливаю Next.js и Socket.IO...\n");
    shutdown(0);
  });
}
