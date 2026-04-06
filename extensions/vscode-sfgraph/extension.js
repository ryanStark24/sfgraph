"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

let serverProcess = null;
let outputChannel = null;
let statusBarItem = null;
let progressPollHandle = null;
let currentRepoPath = "";

function activate(context) {
  outputChannel = vscode.window.createOutputChannel("sfgraph");
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "sfgraph.startServer";
  updateStatusBar(false);
  statusBarItem.show();

  context.subscriptions.push(
    outputChannel,
    statusBarItem,
    vscode.commands.registerCommand("sfgraph.installDependencies", installDependencies),
    vscode.commands.registerCommand("sfgraph.startServer", startServer),
    vscode.commands.registerCommand("sfgraph.stopServer", stopServer),
    vscode.commands.registerCommand("sfgraph.writeCursorMcpConfig", writeCursorMcpConfig),
    vscode.commands.registerCommand("sfgraph.showProgress", showProgress),
    {
      dispose: () => {
        stopProgressPolling();
        if (serverProcess) {
          serverProcess.kill();
          serverProcess = null;
        }
      }
    }
  );
}

function deactivate() {
  stopProgressPolling();
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

function updateStatusBar(running, progressText = "") {
  if (!statusBarItem) {
    return;
  }
  if (running) {
    statusBarItem.text = progressText || "$(debug-stop) sfgraph: Stop Server";
    statusBarItem.command = progressText ? "sfgraph.showProgress" : "sfgraph.stopServer";
    statusBarItem.tooltip = progressText
      ? "Show the latest sfgraph ingestion progress"
      : "Stop the sfgraph MCP server";
    return;
  }
  statusBarItem.text = "$(play) sfgraph: Start Server";
  statusBarItem.command = "sfgraph.startServer";
  statusBarItem.tooltip = "Start the sfgraph MCP server";
}

function getWorkspaceRoot() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return folder ? folder.uri.fsPath : "";
}

function looksLikeRepoRoot(candidate) {
  if (!candidate) {
    return false;
  }
  return fs.existsSync(path.join(candidate, "pyproject.toml")) &&
    fs.existsSync(path.join(candidate, "src", "sfgraph", "server.py"));
}

async function resolveRepoPath() {
  const config = vscode.workspace.getConfiguration("sfgraph");
  const configured = config.get("repoPath", "").trim();
  if (looksLikeRepoRoot(configured)) {
    return configured;
  }

  const workspaceRoot = getWorkspaceRoot();
  if (looksLikeRepoRoot(workspaceRoot)) {
    return workspaceRoot;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Select sfgraph repo root"
  });
  if (!picked || !picked[0]) {
    return "";
  }
  return picked[0].fsPath;
}

function getPythonPath(repoPath) {
  const venvPython = process.platform === "win32"
    ? path.join(repoPath, ".venv", "Scripts", "python.exe")
    : path.join(repoPath, ".venv", "bin", "python");
  return fs.existsSync(venvPython) ? venvPython : "python3";
}

function getDataDir(repoPath) {
  const config = vscode.workspace.getConfiguration("sfgraph");
  const configured = String(config.get("dataDir", "") || "").trim();
  if (configured) {
    return configured;
  }
  return path.join(repoPath, "data");
}

function getProgressFile(repoPath) {
  return path.join(getDataDir(repoPath), "ingestion_progress.json");
}

function readProgressSnapshot(repoPath) {
  if (!repoPath) {
    return null;
  }
  const progressFile = getProgressFile(repoPath);
  if (!fs.existsSync(progressFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(progressFile, "utf8"));
  } catch (_error) {
    return null;
  }
}

function formatProgressText(progress) {
  if (!progress || progress.state !== "running") {
    return "$(debug-stop) sfgraph: Stop Server";
  }
  const processed = Number.isFinite(progress.processed_files) ? progress.processed_files : 0;
  const total = Number.isFinite(progress.total_files) ? progress.total_files : 0;
  const ratio = typeof progress.completion_ratio === "number"
    ? `${Math.round(progress.completion_ratio * 100)}%`
    : "";
  const phase = progress.phase || "running";
  return `$(sync~spin) sfgraph ${ratio} ${processed}/${total} ${phase}`.trim();
}

function formatProgressDetails(progress) {
  if (!progress) {
    return "No ingestion progress snapshot found yet.";
  }
  return [
    `state: ${progress.state || "unknown"}`,
    `phase: ${progress.phase || "unknown"}`,
    `processed_files: ${progress.processed_files ?? 0}/${progress.total_files ?? 0}`,
    `failed_files: ${progress.failed_files ?? 0}`,
    `current_file: ${progress.current_file || "-"}`,
    `completion_ratio: ${typeof progress.completion_ratio === "number" ? progress.completion_ratio : "-"}`,
    `updated_at: ${progress.updated_at || "-"}`,
  ].join("\n");
}

function refreshProgressUi() {
  const progress = readProgressSnapshot(currentRepoPath);
  updateStatusBar(Boolean(serverProcess), formatProgressText(progress));
}

function stopProgressPolling() {
  if (progressPollHandle) {
    clearInterval(progressPollHandle);
    progressPollHandle = null;
  }
}

function startProgressPolling(repoPath) {
  currentRepoPath = repoPath;
  stopProgressPolling();
  const config = vscode.workspace.getConfiguration("sfgraph");
  const intervalMs = Math.max(500, Number(config.get("progressPollMs", 2000)) || 2000);
  refreshProgressUi();
  progressPollHandle = setInterval(refreshProgressUi, intervalMs);
}

async function installDependencies() {
  const repoPath = await resolveRepoPath();
  if (!repoPath) {
    vscode.window.showErrorMessage("sfgraph repo path not found.");
    return;
  }

  const terminal = vscode.window.createTerminal({
    name: "sfgraph setup",
    cwd: repoPath
  });
  terminal.show();
  terminal.sendText("uv sync", true);
  terminal.sendText("npm install", true);
}

async function startServer() {
  if (serverProcess) {
    vscode.window.showInformationMessage("sfgraph MCP server is already running.");
    return;
  }

  const repoPath = await resolveRepoPath();
  if (!repoPath) {
    vscode.window.showErrorMessage("sfgraph repo path not found.");
    return;
  }
  currentRepoPath = repoPath;

  const pythonPath = getPythonPath(repoPath);
  const env = {
    ...process.env,
    PYTHONPATH: path.join(repoPath, "src")
  };

  outputChannel.clear();
  outputChannel.show(true);
  outputChannel.appendLine(`Starting sfgraph MCP server from ${repoPath}`);

  serverProcess = cp.spawn(pythonPath, ["-m", "sfgraph.server"], {
    cwd: repoPath,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  serverProcess.stdout.on("data", (chunk) => {
    outputChannel.append(chunk.toString());
  });
  serverProcess.stderr.on("data", (chunk) => {
    outputChannel.append(chunk.toString());
  });

  serverProcess.on("exit", (code, signal) => {
    outputChannel.appendLine(`sfgraph server exited (code=${code}, signal=${signal})`);
    stopProgressPolling();
    serverProcess = null;
    updateStatusBar(false);
  });

  serverProcess.on("error", (error) => {
    outputChannel.appendLine(`Failed to start sfgraph server: ${error.message}`);
    vscode.window.showErrorMessage(`Failed to start sfgraph server: ${error.message}`);
    stopProgressPolling();
    serverProcess = null;
    updateStatusBar(false);
  });

  startProgressPolling(repoPath);
  updateStatusBar(true);
  vscode.window.showInformationMessage("sfgraph MCP server started.");
}

async function stopServer() {
  if (!serverProcess) {
    vscode.window.showInformationMessage("sfgraph MCP server is not running.");
    return;
  }
  stopProgressPolling();
  serverProcess.kill();
  serverProcess = null;
  updateStatusBar(false);
  vscode.window.showInformationMessage("sfgraph MCP server stopped.");
}

async function showProgress() {
  const repoPath = currentRepoPath || await resolveRepoPath();
  if (!repoPath) {
    vscode.window.showErrorMessage("sfgraph repo path not found.");
    return;
  }
  const progress = readProgressSnapshot(repoPath);
  if (!progress) {
    vscode.window.showInformationMessage("No sfgraph ingestion progress snapshot found yet.");
    return;
  }
  outputChannel.show(true);
  outputChannel.appendLine("[sfgraph] ingestion progress");
  outputChannel.appendLine(formatProgressDetails(progress));
  vscode.window.showInformationMessage(
    `sfgraph ${progress.phase || "running"} ${progress.processed_files ?? 0}/${progress.total_files ?? 0}`
  );
}

async function writeCursorMcpConfig() {
  const repoPath = await resolveRepoPath();
  if (!repoPath) {
    vscode.window.showErrorMessage("sfgraph repo path not found.");
    return;
  }

  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage("Open a workspace folder before writing MCP config.");
    return;
  }

  const config = vscode.workspace.getConfiguration("sfgraph");
  const serverName = config.get("serverName", "sfgraph");
  const pythonPath = getPythonPath(repoPath);
  const cursorDir = path.join(workspaceRoot, ".cursor");
  const cursorFile = path.join(cursorDir, "mcp.json");

  fs.mkdirSync(cursorDir, { recursive: true });

  let payload = { mcpServers: {} };
  if (fs.existsSync(cursorFile)) {
    try {
      payload = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
    } catch (_error) {
      payload = { mcpServers: {} };
    }
  }

  if (!payload.mcpServers || typeof payload.mcpServers !== "object") {
    payload.mcpServers = {};
  }

  payload.mcpServers[serverName] = {
    command: pythonPath,
    args: ["-m", "sfgraph.server"],
    cwd: repoPath,
    env: {
      PYTHONPATH: path.join(repoPath, "src")
    }
  };

  fs.writeFileSync(cursorFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  vscode.window.showInformationMessage(`Wrote MCP config to ${cursorFile}`);
}

module.exports = {
  activate,
  deactivate
};
