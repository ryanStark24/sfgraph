// src/sfgraph/parser/worker/worker.js
// WASM readline IPC worker for Apex parsing.
// POOL-01: grammar loaded once at startup (not per file)
// POOL-02: newline-delimited JSON over stdin/stdout
// POOL-05: self-exits after MAX_FILES to prevent Node.js heap accumulation

'use strict';

const { getApexParser } = require('web-tree-sitter-sfapex');
const readline = require('readline');

const MAX_FILES = 200;

let apexParser = null;
let fileCount = 0;

/**
 * extractRawFacts — Phase 2 stub. Phase 3 expands CST traversal.
 * @param {object} root - tree-sitter root node
 * @param {string} filePath - source file path for context
 * @returns {object} raw facts payload
 */
function extractRawFacts(root, filePath) {
  const classes = root.descendantsOfType('class_declaration');
  return {
    filePath,
    hasError: root.hasError,
    nodeCount: classes.length,
    nodes: [],
    potential_refs: [],
  };
}

/**
 * handleLine — dispatches a single newline-delimited JSON message.
 * @param {string} line - raw JSON string from stdin
 */
function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line.trim());
  } catch (e) {
    process.stderr.write('[worker] JSON parse error: ' + e.message + '\n');
    return;
  }

  // ping → pong health check (POOL-04)
  if (msg.type === 'ping') {
    process.stdout.write(JSON.stringify({ requestId: msg.requestId, type: 'pong' }) + '\n');
    return;
  }

  // graceful shutdown
  if (msg.type === 'exit') {
    process.exit(0);
  }

  // parse request
  try {
    fileCount++;

    // POOL-05: memory ceiling — voluntary replacement after MAX_FILES
    if (fileCount > MAX_FILES) {
      process.stdout.write(
        JSON.stringify({
          requestId: msg.requestId,
          ok: false,
          error: 'memory_ceiling',
          payload: null,
        }) + '\n'
      );
      process.exit(0);
    }

    const content = msg.fileContent || '';
    const tree = apexParser.parse(content);
    const root = tree.rootNode;

    // APEX-10 guard: hasError is a PROPERTY (boolean) in WASM API — NOT a method
    if (root.hasError) {
      process.stderr.write('[worker] parse error in ' + msg.filePath + '\n');
      process.stdout.write(
        JSON.stringify({
          requestId: msg.requestId,
          ok: false,
          error: 'parse_error',
          payload: null,
        }) + '\n'
      );
      return;
    }

    const payload = extractRawFacts(root, msg.filePath);
    process.stdout.write(
      JSON.stringify({
        requestId: msg.requestId,
        ok: true,
        payload,
      }) + '\n'
    );
  } catch (e) {
    process.stderr.write('[worker] exception: ' + e.message + '\n');
    process.stdout.write(
      JSON.stringify({
        requestId: msg.requestId,
        ok: false,
        error: e.message,
        payload: null,
      }) + '\n'
    );
  }
}

/**
 * init — load WASM grammar once, then start readline loop.
 * Grammar load amortizes ~300ms startup cost across all files processed.
 */
async function init() {
  try {
    apexParser = await getApexParser();
    process.stderr.write('[worker] initialized\n');

    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', handleLine);
    process.stdin.resume();
  } catch (e) {
    process.stderr.write('[worker] init failed: ' + e.message + '\n');
    process.exit(1);
  }
}

init();
