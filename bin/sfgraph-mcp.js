#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");

const DEFAULT_PACKAGE_SPEC = process.env.SFGRAPH_PYTHON_PACKAGE_SPEC || "git+https://github.com/ryanStark24/sfgraph.git";
const DEFAULT_RUNTIME_DIR = process.env.SFGRAPH_RUNTIME_DIR || getDefaultRuntimeDir();

function getDefaultRuntimeDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "sfgraph-mcp");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), "sfgraph-mcp");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "sfgraph-mcp");
}

function parseArgs(argv) {
  const options = {
    packageSpec: DEFAULT_PACKAGE_SPEC,
    runtimeDir: DEFAULT_RUNTIME_DIR,
    reinstall: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--package-spec" && argv[i + 1]) {
      options.packageSpec = argv[i + 1];
      i += 1;
      continue;
    }
    if (value === "--runtime-dir" && argv[i + 1]) {
      options.runtimeDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (value === "--reinstall") {
      options.reinstall = true;
      continue;
    }
  }

  return options;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_error) {
    return "";
  }
}

function run(command, args, options = {}) {
  const printable = [command, ...args].join(" ");
  process.stderr.write(`[sfgraph-mcp] ${printable}\n`);
  const result = cp.spawnSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: options.cwd,
    env: options.env || process.env,
    shell: false,
    encoding: "utf8"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = options.capture ? (result.stderr || "") : "";
    throw new Error(`Command failed (${result.status}): ${printable}${stderr ? `\n${stderr}` : ""}`);
  }
  return result;
}

function getWorkspacePaths(runtimeDir, workspaceRoot) {
  const workspaceHash = crypto.createHash("sha1").update(workspaceRoot).digest("hex").slice(0, 12);
  const workspaceDir = path.join(runtimeDir, "workspaces", workspaceHash);
  const dataDir = path.join(workspaceDir, "data");
  const pidFile = path.join(workspaceDir, "server.pid");
  return { workspaceDir, dataDir, pidFile };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function looksLikeSfgraphServerPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) {
    return false;
  }
  if (process.platform === "win32") {
    return true;
  }
  try {
    const result = run("ps", ["-p", String(pid), "-o", "command="], { capture: true });
    const command = (result.stdout || "").trim();
    return command.includes("sfgraph.server");
  } catch (_error) {
    return false;
  }
}

function sleep(ms) {
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);
  Atomics.wait(int32, 0, 0, ms);
}

function cleanupExistingServer(pidFile) {
  if (!fileExists(pidFile)) {
    return;
  }
  const raw = readTextIfExists(pidFile).trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    fs.rmSync(pidFile, { force: true });
    return;
  }
  if (!looksLikeSfgraphServerPid(pid)) {
    fs.rmSync(pidFile, { force: true });
    return;
  }

  process.stderr.write(`[sfgraph-mcp] stopping existing sfgraph.server pid ${pid}\n`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (_error) {
    fs.rmSync(pidFile, { force: true });
    return;
  }

  for (let i = 0; i < 20; i += 1) {
    if (!processExists(pid)) {
      fs.rmSync(pidFile, { force: true });
      return;
    }
    sleep(100);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (_error) {
    // Best-effort cleanup only.
  }
  fs.rmSync(pidFile, { force: true });
}

function resolveNodeModulesDir() {
  const candidates = [];
  try {
    const pkgPath = require.resolve("web-tree-sitter-sfapex/package.json");
    candidates.push(path.dirname(path.dirname(pkgPath)));
  } catch (_error) {
    // Ignore and fall back to common layouts below.
  }
  candidates.push(path.join(__dirname, "..", "node_modules"));
  candidates.push(path.join(process.cwd(), "node_modules"));

  for (const candidate of candidates) {
    if (candidate && fileExists(path.join(candidate, "web-tree-sitter-sfapex", "package.json"))) {
      return candidate;
    }
  }
  throw new Error("Unable to resolve node_modules path for web-tree-sitter-sfapex.");
}

function resolvePythonBootstrapCommand() {
  const candidates = [
    { command: "python3.12", args: ["--version"] },
    { command: "python3", args: ["--version"] },
    { command: "python", args: ["--version"] }
  ];

  if (process.platform === "win32") {
    candidates.unshift({ command: "py", args: ["-3.12", "--version"], launcher: true, baseArgs: ["-3.12"] });
    candidates.push({ command: "py", args: ["-3", "--version"], launcher: true, baseArgs: ["-3"] });
  }

  for (const candidate of candidates) {
    try {
      run(candidate.command, candidate.args, { capture: true });
      return candidate.launcher
        ? { command: candidate.command, baseArgs: candidate.baseArgs || ["-3"] }
        : { command: candidate.command, baseArgs: [] };
    } catch (_error) {
      continue;
    }
  }

  throw new Error("Python 3 was not found. Install Python 3.12+ to use sfgraph-mcp.");
}

function getVenvPaths(runtimeDir) {
  const venvDir = path.join(runtimeDir, "venv");
  const pythonPath = process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
  return { venvDir, pythonPath };
}

function getPythonVersionTag(command, baseArgs) {
  const result = run(
    command,
    [...baseArgs, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
    { capture: true }
  );
  return (result.stdout || "").trim() || "unknown";
}

function readState(statePath) {
  if (!fileExists(statePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (_error) {
    return {};
  }
}

function writeState(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function needsBootstrap(pythonPath, packageSpec, statePath, reinstall) {
  if (reinstall || !fileExists(pythonPath)) {
    return true;
  }
  const state = readState(statePath);
  if (state.packageSpec !== packageSpec) {
    return true;
  }
  try {
    run(pythonPath, ["-c", "import sfgraph.server"], { capture: true });
    return false;
  } catch (_error) {
    return true;
  }
}

function bootstrapRuntime(runtimeDir, packageSpec, reinstall) {
  ensureDir(runtimeDir);
  const bootstrap = resolvePythonBootstrapCommand();
  const pythonVersionTag = getPythonVersionTag(bootstrap.command, bootstrap.baseArgs);
  const versionedRuntimeDir = path.join(runtimeDir, `py${pythonVersionTag}`);
  ensureDir(versionedRuntimeDir);
  const statePath = path.join(versionedRuntimeDir, "state.json");
  const { venvDir, pythonPath } = getVenvPaths(versionedRuntimeDir);

  if (!needsBootstrap(pythonPath, packageSpec, statePath, reinstall)) {
    return { pythonPath, venvDir };
  }

  if (!fileExists(pythonPath)) {
    run(bootstrap.command, [...bootstrap.baseArgs, "-m", "venv", venvDir]);
  }

  run(pythonPath, ["-m", "pip", "install", "--upgrade", "pip"]);
  run(pythonPath, ["-m", "pip", "install", "--upgrade", "--force-reinstall", packageSpec]);
  writeState(statePath, {
    packageSpec,
    pythonVersion: pythonVersionTag,
    bootstrappedAt: new Date().toISOString()
  });
  return { pythonPath, venvDir };
}

function startServer(pythonPath, runtimeDir) {
  const nodePath = resolveNodeModulesDir();
  const sfapexPackage = path.join(nodePath, "web-tree-sitter-sfapex");
  const workspaceRoot = process.cwd();
  const { workspaceDir, dataDir, pidFile } = getWorkspacePaths(runtimeDir, workspaceRoot);
  ensureDir(workspaceDir);
  ensureDir(dataDir);
  cleanupExistingServer(pidFile);
  const env = {
    ...process.env,
    NODE_PATH: process.env.NODE_PATH ? `${nodePath}${path.delimiter}${process.env.NODE_PATH}` : nodePath,
    SFGRAPH_NODE_MODULES_DIR: process.env.SFGRAPH_NODE_MODULES_DIR || nodePath,
    SFGRAPH_SFAPEX_PACKAGE: process.env.SFGRAPH_SFAPEX_PACKAGE || sfapexPackage,
    SFGRAPH_DATA_DIR: process.env.SFGRAPH_DATA_DIR || dataDir
  };

  const child = cp.spawn(pythonPath, ["-m", "sfgraph.server"], {
    cwd: workspaceRoot,
    env,
    stdio: "inherit"
  });
  fs.writeFileSync(pidFile, `${child.pid}\n`, "utf8");

  child.on("exit", (code, signal) => {
    fs.rmSync(pidFile, { force: true });
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { pythonPath } = bootstrapRuntime(options.runtimeDir, options.packageSpec, options.reinstall);
    startServer(pythonPath, options.runtimeDir);
  } catch (error) {
    process.stderr.write(`[sfgraph-mcp] ${error.message}\n`);
    process.exit(1);
  }
}

main();
