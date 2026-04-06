"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

let serverProcess = null;
let outputChannel = null;
let statusBarItem = null;

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
    {
      dispose: () => {
        if (serverProcess) {
          serverProcess.kill();
          serverProcess = null;
        }
      }
    }
  );
}

function deactivate() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

function updateStatusBar(running) {
  if (!statusBarItem) {
    return;
  }
  statusBarItem.text = running ? "$(debug-stop) sfgraph: Stop Server" : "$(play) sfgraph: Start Server";
  statusBarItem.command = running ? "sfgraph.stopServer" : "sfgraph.startServer";
  statusBarItem.tooltip = running ? "Stop the sfgraph MCP server" : "Start the sfgraph MCP server";
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
    serverProcess = null;
    updateStatusBar(false);
  });

  serverProcess.on("error", (error) => {
    outputChannel.appendLine(`Failed to start sfgraph server: ${error.message}`);
    vscode.window.showErrorMessage(`Failed to start sfgraph server: ${error.message}`);
    serverProcess = null;
    updateStatusBar(false);
  });

  updateStatusBar(true);
  vscode.window.showInformationMessage("sfgraph MCP server started.");
}

async function stopServer() {
  if (!serverProcess) {
    vscode.window.showInformationMessage("sfgraph MCP server is not running.");
    return;
  }
  serverProcess.kill();
  serverProcess = null;
  updateStatusBar(false);
  vscode.window.showInformationMessage("sfgraph MCP server stopped.");
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
