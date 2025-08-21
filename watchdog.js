#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";
import chokidar from "chokidar";
import SFTPClient from "ssh2-sftp-client";
import createTransport from './lib/transports/index.js';
import minimist from "minimist";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { toRel, normalizeRemote, isSafeRemotePath as safeRemote } from './lib/paths.js';


const args = minimist(process.argv.slice(2));
const dryRun = !!args["dry-run"];
const configPath = args.config || "watchdog.config.json";
const cliConcurrency = args.concurrency ? parseInt(args.concurrency, 10) : undefined;
const verboseFlag = !!args.verbose;
const silentFlag = !!args.silent;
const cliLogLevel = args["log-level"] ? String(args["log-level"]).toLowerCase() : undefined;
const strictDelete = !!args["strict-delete"];
const authFlag = args.auth ? String(args.auth).toLowerCase() : undefined; // allowed: 'key' or 'password'

// Print version and exit
if (args.version || args.V) {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    console.log(`watchdog v${pkg.version}`);
  } catch (e) {
    console.log('watchdog (version unknown)');
  }
  process.exit(0);
}

if (args.help || args.h) {
  console.log(`
Usage: watchdog --config path/to/config.json [options]

Options:
  --config           Path to config file (default: watchdog.config.json)
  --dry-run          Do not modify remote, only log intended actions
  --concurrency N    Number of parallel uploads (default from config)
  --verbose          Enable debug logging
  --silent           Errors only (overrides log level)
  --log-level L      Set log level: error|warn|info|debug
  --strict-delete    Exit with error if an unsafe delete/rmdir is detected
  --auth MODE        Force auth method: key | password
  --version          Show version and exit
  -h, --help         Show this help
`);
  process.exit(0);
}

if (authFlag && !['key', 'password'].includes(authFlag)) {
  console.error(`Invalid --auth value: ${authFlag}. Allowed: key, password`);
  process.exit(1);
}

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
if (cliLogLevel && LEVELS[cliLogLevel] != null) effectiveLevel = LEVELS[cliLogLevel];
if (verboseFlag) effectiveLevel = LEVELS.debug;
if (silentFlag) effectiveLevel = LEVELS.error;
function log(level, ...msg) {
  const lvl = LEVELS[level];
  if (lvl == null || lvl > effectiveLevel) return;
  const color = level === "error" ? chalk.redBright : level === "warn" ? chalk.yellowBright : level === "debug" ? chalk.gray : chalk.white;
  console.log(color(`[${level.toUpperCase()}]`), ...msg);
}

if (!sourceDir || !server?.remoteBaseDir) {
  console.error("Config is missing required fields: sourceDir, server.remoteBaseDir");
  process.exit(1);
}

// Minimal transport-specific validation
const serverType = String(server.type || 'sftp').toLowerCase();
function bad(msg) { console.error(msg); process.exit(1); }
switch (serverType) {
  case 'sftp':
    if (!server.host || !server.username) bad("SFTP requires server.host and server.username");
    break;
  case 'ftp':
  case 'ftps':
    if (!server.host || !server.username) bad("FTP/FTPS requires server.host and server.username");
    break;
  case 'webdav':
    if (!server.url && !server.host) bad("WebDAV requires server.url or server.host");
    break;
  case 's3':
    if (!server.bucket && !process.env.WATCHDOG_S3_BUCKET) bad("S3 requires server.bucket or WATCHDOG_S3_BUCKET");
    break;
  case 'azure':
    if (!server.container && !process.env.WATCHDOG_AZURE_CONTAINER) bad("Azure requires server.container or WATCHDOG_AZURE_CONTAINER");
    break;
  case 'gcs':
    if (!server.bucket && !process.env.WATCHDOG_GCS_BUCKET) bad("GCS requires server.bucket or WATCHDOG_GCS_BUCKET");
    break;
  case 'tus':
    if (!server.endpoint && !process.env.TUS_ENDPOINT) bad("tus requires server.endpoint or TUS_ENDPOINT");
    break;
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Authentication helpers: support config-based values and environment-variable fallbacks
let privateKey;
const envPrivateKey = process.env.WATCHDOG_PRIVATE_KEY;
if (server.privateKey) {
  const pkPath = expandHome(server.privateKey);
  try {
    if (fs.existsSync(pkPath)) {
      privateKey = fs.readFileSync(pkPath);
    } else {
      console.warn(`[WARN] Private key not found at ${pkPath} — will try environment variable or password if provided`);
    }
  } catch (e) {
    console.warn(`[WARN] Failed reading private key ${pkPath}: ${e.message}`);
  }
} else if (envPrivateKey) {
  // env value may be either a path to a key file or the key contents itself
  try {
    if (fs.existsSync(envPrivateKey)) {
      privateKey = fs.readFileSync(envPrivateKey);
    } else {
      // treat env value as key content
      privateKey = Buffer.from(envPrivateKey);
    }
    log('debug', 'Using private key from environment variable WATCHDOG_PRIVATE_KEY');
  } catch (e) {
    console.warn(`[WARN] Failed to use WATCHDOG_PRIVATE_KEY: ${e.message}`);
  }
}
const remoteBase = server.remoteBaseDir.replace(/\\/g, "/"); // ensure POSIX

// ---- transport selection (SFTP default) ----
let transport = null; // will hold adapter with unified methods: connect, fastPut, delete, mkdir, rmdir, list, put, end
let connecting = null;

async function ensureConnected() {
  if (transport && transport._connected) return transport;
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      const type = (server.type || 'sftp').toLowerCase();
      if (type === 'sftp') {
        // keep existing SFTPClient behavior for backward compatibility
        const sftp = new SFTPClient();
        const connOpts = {
          host: server.host,
          port: server.port || 22,
          username: server.username
        };
        const envPassword = process.env.WATCHDOG_PASSWORD;
        if (authFlag === 'key') {
          if (!privateKey) throw new Error('--auth=key requested but no private key is available (config or WATCHDOG_PRIVATE_KEY)');
          connOpts.privateKey = privateKey;
        } else if (authFlag === 'password') {
          const pwd = server.password || envPassword;
          if (!pwd) throw new Error('--auth=password requested but no password is available (config or WATCHDOG_PASSWORD)');
          connOpts.password = pwd;
        } else {
          if (privateKey) connOpts.privateKey = privateKey;
          else if (server.password) connOpts.password = server.password;
          else if (envPassword) connOpts.password = envPassword;
          else throw new Error('No authentication method provided (privateKey or password)');
        }
        const authMethod = connOpts.privateKey ? 'privateKey' : 'password';
        log('info', `Connecting to ${server.username}@${server.host} using ${authMethod}`);
        await sftp.connect(connOpts);
        // wire sftp methods into transport-shaped wrapper
        transport = {
          _connected: true,
          fastPut: (...args) => sftp.fastPut(...args),
          put: (...args) => sftp.put(...args),
          delete: (...args) => sftp.delete(...args),
          mkdir: (...args) => sftp.mkdir(...args),
          rmdir: (...args) => sftp.rmdir(...args),
          list: (...args) => sftp.list(...args),
          end: async () => { try { await sftp.end(); } catch (e) {} }
        };
        // ensure base dir exists
        try { await transport.mkdir(remoteBase, true); } catch (e) { /* ignore */ }
        return transport;
      }

      // non-sftp transports
  transport = await createTransport(server, process.env);
  await transport.connect();
      transport._connected = true;
      // ensure base dir exists for transports that support mkdir
      try { await transport.mkdir(remoteBase); } catch (e) { /* ignore */ }
      return transport;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

// ---- helpers ----
function rel(p) { return toRel(sourceDir, p); }
function remotePath(localAbs) { return normalizeRemote(remoteBase, rel(localAbs)); }
function isSafeRemotePath(rp) { return safeRemote(remoteBase, rp); }

async function mkdirp(remoteDir) {
  try {
  await transport.mkdir(remoteDir, true);
  } catch (e) {
    if (!/Failure|exists/i.test(String(e))) throw e;
  }
}

async function uploadFile(localAbs) {
  // make sure parent exists
  const rPath = remotePath(localAbs);
  if (!isSafeRemotePath(rPath)) {
    stats.errors++;
    console.warn(chalk.redBright(`[SAFEGUARD] Refusing to upload outside base: ${rPath}`));
    return;
  }
  const rDir = rPath.substring(0, rPath.lastIndexOf("/")) || remoteBase;
  if (dryRun) {
    console.log(chalk.yellowBright("[dry-run] ↑ would upload:", rel(localAbs)));
    return;
  }
  try {
  await mkdirp(rDir);
  await transport.fastPut(localAbs, rPath);
  stats.uploaded++;
  console.log(chalk.greenBright("↑ uploaded:", rel(localAbs)));
  } catch (e) {
  stats.errors++;
  console.error(chalk.redBright(`[ERROR] Failed to upload ${rel(localAbs)}: ${e.message}`));
  }
}

async function deleteRemote(localAbs) {
  const rPath = remotePath(localAbs);
  if (!isSafeRemotePath(rPath)) {
    stats.errors++;
    console.warn(chalk.redBright(`[SAFEGUARD] Refusing to delete outside base: ${rPath}`));
    if (strictDelete) {
      console.error(chalk.redBright(`[STRICT] Unsafe delete detected for ${rel(localAbs)} — exiting.`));
      process.exit(2);
    }
    return;
  }
  if (dryRun) {
    console.log(chalk.yellowBright("[dry-run] ✖ would delete:", rel(localAbs)));
    return;
  }
  try {
  await transport.delete(rPath);
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
  const rPath = remotePath(localAbs);
  if (!isSafeRemotePath(rPath)) {
    stats.errors++;
    console.warn(chalk.redBright(`[SAFEGUARD] Refusing to rmdir outside base: ${rPath}`));
    if (strictDelete) {
      console.error(chalk.redBright(`[STRICT] Unsafe rmdir detected for ${rel(localAbs)} — exiting.`));
      process.exit(2);
    }
    return;
  }
  if (dryRun) {
    console.log(chalk.yellowBright("[dry-run] － would delete dir:", rel(localAbs)));
    return;
  }
  try {
  await transport.rmdir(rPath, true);
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

  // Test hook: allow integration tests to trigger a single delete operation
  // without connecting or starting the watcher. Only active when this env var is set.
  if (process.env.WATCHDOG_TEST_STRICT_DELETE) {
    const target = process.env.WATCHDOG_TEST_STRICT_DELETE;
    try {
      await deleteRemote(target);
      // If strict-delete didn't exit, fail the test path explicitly
      console.error(chalk.redBright('[TEST] strict-delete did not trigger exit'));
      process.exit(3);
    } catch (e) {
      // Any thrown error will be reflected in process exit by the catch below
      console.error(chalk.redBright('[TEST] Unexpected error:', e.message));
      process.exit(4);
    }
    return; // safety
  }

  // --- SFTP connection and permission check ---
  try {
    const t = await ensureConnected();
    // Check remote base for existence and write permission where supported
    try { await t.list(remoteBase); } catch (e) { /* ignore */ }
    // Try to write a temp file if adapter supports put
    try {
      const testFile = path.posix.join(remoteBase, `.watchdog_test_${Date.now()}`);
      if (typeof t.put === 'function') {
        await t.put(Buffer.from('test'), testFile);
        if (typeof t.delete === 'function') await t.delete(testFile);
      }
    } catch (e) { /* ignore */ }
    console.log(chalk.greenBright("[Transport] Connection OK."));
  } catch (e) {
    console.error(chalk.redBright("[ERROR] Connection or permission check failed:", e.message));
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

  // Periodic debug monitor of queue depth
  let monitorInterval = null;
  if (effectiveLevel >= LEVELS.debug) {
    monitorInterval = setInterval(() => {
      log('debug', `monitor queue=${queue.length} active=${active} pending=${pending.size}`);
    }, 5000);
  }
  
  const shutdown = async () => {
    console.log("\nShutting down…");
    clearTimeout(flushTimer);
    if (monitorInterval) clearInterval(monitorInterval);
    const elapsed = (Date.now() - stats.start) / 1000;
    console.log(chalk.whiteBright(`Runtime: ${elapsed.toFixed(1)}s`));
    console.log(chalk.whiteBright(`Uploaded: ${stats.uploaded}, Deleted: ${stats.deleted}, Dirs+: ${stats.createdDir}, Dirs-: ${stats.removedDir}`));
    if (stats.skippedLarge) console.log(chalk.yellowBright(`Skipped large: ${stats.skippedLarge}`));
    if (stats.errors) console.log(chalk.redBright(`Errors: ${stats.errors}`));
  try { if (transport) await transport.end(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})();
