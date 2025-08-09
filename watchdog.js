#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";
import chokidar from "chokidar";
import SFTPClient from "ssh2-sftp-client";
import minimist from "minimist";
import chalk from "chalk";
import { minimatch } from "minimatch";


const args = minimist(process.argv.slice(2));
const dryRun = !!args["dry-run"];
const configPath = args.config || "watchdog.config.json";
const cliConcurrency = args.concurrency ? parseInt(args.concurrency, 10) : undefined;
const verboseFlag = !!args.verbose;

if (!fs.existsSync(configPath)) {
  console.error(`Config file not found: ${configPath}\nUse --config path/to/config.json`);
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));

// ---- config defaults ----
const {
  sourceDir,
  ignore = [".git", "node_modules", ".DS_Store", "**/*.log", "**/*.tmp"],
  server,
  debounceMs = 500,
  concurrency: cfgConcurrency = 2,
  deleteOnRemote = false,
  initialSync = false,
  maxFileSizeBytes = 0,
  logLevel = "info"
} = cfg;

const concurrency = cliConcurrency || cfgConcurrency;

// logging levels & helper
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let effectiveLevel = LEVELS[logLevel] != null ? LEVELS[logLevel] : LEVELS.info;
if (verboseFlag) effectiveLevel = LEVELS.debug;
function log(level, ...msg) {
  const lvl = LEVELS[level];
  if (lvl == null || lvl > effectiveLevel) return;
  const color = level === "error" ? chalk.redBright : level === "warn" ? chalk.yellowBright : level === "debug" ? chalk.gray : chalk.white;
  console.log(color(`[${level.toUpperCase()}]`), ...msg);
}

if (!sourceDir || !server?.host || !server?.username || !server?.remoteBaseDir) {
  console.error("Config is missing required fields: sourceDir, server.host, server.username, server.remoteBaseDir");
  process.exit(1);
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const privateKey = server.privateKey ? fs.readFileSync(expandHome(server.privateKey)) : undefined;
const remoteBase = server.remoteBaseDir.replace(/\\/g, "/"); // ensure POSIX

// ---- sftp client with simple reconnect ----
const sftp = new SFTPClient();
let connecting = null;

async function ensureConnected() {
  if (sftp.sftp) return sftp;
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      await sftp.connect({
        host: server.host,
        port: server.port || 22,
        username: server.username,
        password: server.password,
        privateKey
      });
      // Ensure base dir exists
      await mkdirp(remoteBase);
      return sftp;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

sftp.on("end", () => console.warn("[SFTP] connection ended"));
sftp.on("close", () => console.warn("[SFTP] connection closed"));
sftp.on("error", (e) => console.error("[SFTP] error:", e.message));

// ---- helpers ----
function rel(p) {
  return path.relative(sourceDir, p).replace(/\\/g, "/");
}

function remotePath(localAbs) {
  return `${remoteBase}/${rel(localAbs)}`.replace(/\/+/g, "/");
}

async function mkdirp(remoteDir) {
  try {
    await sftp.mkdir(remoteDir, true);
  } catch (e) {
    if (!/Failure|exists/i.test(String(e))) throw e;
  }
}

async function uploadFile(localAbs) {
  // make sure parent exists
  const rPath = remotePath(localAbs);
  const rDir = rPath.substring(0, rPath.lastIndexOf("/")) || remoteBase;
  if (dryRun) {
    console.log(chalk.yellowBright("[dry-run] ↑ would upload:", rel(localAbs)));
    return;
  }
  try {
  await mkdirp(rDir);
  await sftp.fastPut(localAbs, rPath);
  stats.uploaded++;
  console.log(chalk.greenBright("↑ uploaded:", rel(localAbs)));
  } catch (e) {
  stats.errors++;
  console.error(chalk.redBright(`[ERROR] Failed to upload ${rel(localAbs)}: ${e.message}`));
  }
}

async function deleteRemote(localAbs) {
  const rPath = remotePath(localAbs);
  if (dryRun) {
    console.log(chalk.yellowBright("[dry-run] ✖ would delete:", rel(localAbs)));
    return;
  }
  try {
    await sftp.delete(rPath);
    stats.deleted++;
    console.log(chalk.greenBright("✖ deleted:", rel(localAbs)));
  } catch (e) {
    if (!/No such file|not found/i.test(String(e))) {
      stats.errors++;
      console.warn(chalk.redBright(`[ERROR] Failed to delete ${rel(localAbs)}: ${e.message}`));
    }
  }
}

async function createRemoteDir(localAbs) {
  if (dryRun) {
    console.log(chalk.yellowBright("[dry-run] ＋ would create dir:", rel(localAbs)));
    return;
  }
  try {
  await mkdirp(remotePath(localAbs));
  stats.createdDir++;
  console.log(chalk.greenBright("＋ dir:", rel(localAbs)));
  } catch (e) {
  stats.errors++;
  console.error(chalk.redBright(`[ERROR] Failed to create remote dir ${rel(localAbs)}: ${e.message}`));
  }
}

async function deleteRemoteDir(localAbs) {
  // Best-effort remove; ignore if not empty
  if (dryRun) {
    console.log(chalk.yellowBright("[dry-run] － would delete dir:", rel(localAbs)));
    return;
  }
  try {
  await sftp.rmdir(remotePath(localAbs), true);
  stats.removedDir++;
  console.log(chalk.greenBright("－ dir:", rel(localAbs)));
  } catch (e) {
  stats.errors++;
  console.error(chalk.redBright(`[ERROR] Failed to delete remote dir ${rel(localAbs)}: ${e.message}`));
  }
}

// Precompiled ignore patterns for faster checks
const ignoreMatchers = ignore.map(g => ({ g, test: (p) => minimatch(p, g, { dot: true }) }));
function shouldIgnore(p) {
  const r = rel(p);
  return ignoreMatchers.some(m => m.test(r));
}

// ---- simple task queue with concurrency & debounce ----
const pending = new Map(); // key: absPath -> {type}
let flushTimer = null;
let active = 0;
const queue = [];

// stats collection
const stats = {
  start: Date.now(),
  uploaded: 0,
  deleted: 0,
  createdDir: 0,
  removedDir: 0,
  errors: 0,
  skippedLarge: 0
};

function enqueue(absPath, type) {
  if (shouldIgnore(absPath)) return;
  // coalesce: if we get delete after add, keep the latest event
  pending.set(absPath, type);
  scheduleFlush();
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, debounceMs);
}

async function worker(task) {
  try {
    await ensureConnected();
    switch (task.type) {
      case "add":
      case "change":
        if (fs.existsSync(task.path) && fs.statSync(task.path).isFile()) {
          if (maxFileSizeBytes > 0) {
            const size = fs.statSync(task.path).size;
            if (size > maxFileSizeBytes) {
              stats.skippedLarge++;
              log("warn", `Skipping large file (${size} bytes): ${rel(task.path)}`);
              break;
            }
          }
          await uploadFile(task.path);
        }
        break;
      case "unlink":
        if (deleteOnRemote) await deleteRemote(task.path);
        break;
      case "addDir":
        await createRemoteDir(task.path);
        break;
      case "unlinkDir":
        if (deleteOnRemote) await deleteRemoteDir(task.path);
        break;
    }
  } catch (e) {
    stats.errors++;
    console.error(chalk.redBright(`[${task.type}] ${rel(task.path)} -> ${e.message}`));
  }
}

async function flush() {
  const items = Array.from(pending.entries()).map(([p, type]) => ({ path: p, type }));
  pending.clear();
  // simple round-robin with concurrency limit
  for (const it of items) {
    queue.push(it);
  }
  log("debug", `Queue length: ${queue.length} active: ${active}`);
  while (active < concurrency && queue.length) {
    const task = queue.shift();
    active++;
    worker(task).finally(() => {
      active--;
      if (queue.length) {
        const next = queue.shift();
        active++;
        worker(next).finally(() => {
          active--;
        });
      }
    });
  }
}

// ---- initial sync (optional) ----
async function doInitialSync() {
  // Very simple: walk files and upload once
  console.log("Initial sync started…");
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (ignore.some((g) => minimatch(rel(abs), g, { dot: true }))) continue;
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) enqueue(abs, "change");
    }
  };
  // lazy import minimatch only here
  const { minimatch } = await import("minimatch");
  global.minimatch = minimatch;
  walk(sourceDir);
  scheduleFlush();
}

// ---- start watcher ----
(async () => {
  // Clean, aligned ASCII logo with color
  console.log(chalk.cyanBright(`

 W A T C H D O G                         
`));
  // Show version from package.json (ESM compatible)
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    console.log(chalk.whiteBright(`Version: v${pkg.version}`));
  } catch (e) {
    console.log(chalk.whiteBright('Version: unknown'));
  }
  const absSource = path.resolve(sourceDir);
  if (dryRun) {
    console.log(chalk.yellowBright("[DRY RUN MODE] No files will be uploaded, deleted, or changed on the remote server."));
  }

  // --- SFTP connection and permission check ---
  try {
    const sftpConn = await ensureConnected();
    // Check if remoteBase exists and is writable
    await sftpConn.list(remoteBase);
    // Try to write a temp file
    const testFile = path.posix.join(remoteBase, `.watchdog_sftp_test_${Date.now()}`);
    await sftpConn.put(Buffer.from("test"), testFile);
    await sftpConn.delete(testFile);
    console.log(chalk.greenBright("[SFTP] Connection and permissions OK."));
  } catch (e) {
    console.error(chalk.redBright("[ERROR] SFTP connection or permission check failed:", e.message));
    process.exit(1);
  }
  const watcher = chokidar.watch(absSource, {
    ignored: ignore,
    persistent: true,
    ignoreInitial: !initialSync,
    awaitWriteFinish: {
      stabilityThreshold: 250,
      pollInterval: 50
    }
  });

  watcher
    .on("add", (p) => enqueue(p, "add"))
    .on("change", (p) => enqueue(p, "change"))
    .on("unlink", (p) => enqueue(p, "unlink"))
    .on("addDir", (p) => enqueue(p, "addDir"))
    .on("unlinkDir", (p) => enqueue(p, "unlinkDir"))
    .on("error", (e) => console.error("Watcher error:", e));

  console.log(chalk.greenBright(`Watching: ${absSource}`));
  console.log(chalk.magentaBright(`Remote:   ${server.username}@${server.host}:${remoteBase}`));
  console.log(chalk.blueBright(`Ignores:  ${ignore.join(", ")}`));
  console.log(chalk.whiteBright(`Concurrency: ${concurrency}`));
  if (maxFileSizeBytes) console.log(chalk.whiteBright(`Max file size: ${maxFileSizeBytes} bytes`));
  if (initialSync) {
    await ensureConnected();
    await doInitialSync();
  }
  
  const shutdown = async () => {
    console.log("\nShutting down…");
    clearTimeout(flushTimer);
    const elapsed = (Date.now() - stats.start) / 1000;
    console.log(chalk.whiteBright(`Runtime: ${elapsed.toFixed(1)}s`));
    console.log(chalk.whiteBright(`Uploaded: ${stats.uploaded}, Deleted: ${stats.deleted}, Dirs+: ${stats.createdDir}, Dirs-: ${stats.removedDir}`));
    if (stats.skippedLarge) console.log(chalk.yellowBright(`Skipped large: ${stats.skippedLarge}`));
    if (stats.errors) console.log(chalk.redBright(`Errors: ${stats.errors}`));
    try { await sftp.end(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})();
