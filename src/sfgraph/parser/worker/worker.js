// src/sfgraph/parser/worker/worker.js
// WASM readline IPC worker for Apex parsing.
// POOL-01: grammar loaded once at startup (not per file)
// POOL-02: newline-delimited JSON over stdin/stdout
// POOL-05: self-exits after MAX_FILES to prevent Node.js heap accumulation

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('readline');
const RESPONSE_PREFIX = '@@SFGRAPH_LEN@@';

function loadApexParserModule() {
  const candidates = [];
  if (process.env.SFGRAPH_SFAPEX_PACKAGE) {
    candidates.push(process.env.SFGRAPH_SFAPEX_PACKAGE);
  }
  if (process.env.SFGRAPH_NODE_MODULES_DIR) {
    candidates.push(path.join(process.env.SFGRAPH_NODE_MODULES_DIR, 'web-tree-sitter-sfapex'));
  }
  candidates.push('web-tree-sitter-sfapex');

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Unable to load web-tree-sitter-sfapex');
}

const { getApexParser } = loadApexParserModule();

const MAX_FILES = 200;

let apexParser = null;
let fileCount = 0;

function writeResponse(payload) {
  const body = JSON.stringify(payload);
  process.stdout.write(`${RESPONSE_PREFIX}${Buffer.byteLength(body, 'utf8')}\n`);
  process.stdout.write(body);
}

/**
 * extractRawFacts — Full CST traversal for APEX-01 through APEX-09.
 * @param {object} root - tree-sitter root node
 * @param {string} filePath - source file path for context
 * @returns {object} raw facts payload
 */
function extractRawFacts(root, filePath) {
  // APEX-10 guard: hasError is a PROPERTY (boolean) NOT a method
  if (root.hasError) {
    return { filePath, hasError: true, nodes: [], potential_refs: [] };
  }
  const facts = { filePath, hasError: false, nodes: [], potential_refs: [] };

  // APEX-01: class_declaration nodes
  for (const cls of root.descendantsOfType('class_declaration')) {
    const mods = cls.childForFieldName('modifiers');
    const modsText = mods?.text ?? '';
    const annotations = (mods?.descendantsOfType('annotation') ?? []).map(a => ({
      name: a.descendantsOfType('identifier')[0]?.text ?? '',
    }));
    const isTest = annotations.some(a => a.name.toLowerCase() === 'istest')
                   || modsText.toLowerCase().includes('testmethod');
    const ifaceList = cls.childForFieldName('interfaces');
    const interfaces = (ifaceList?.descendantsOfType('type_identifier') ?? []).map(t => t.text)
      .concat((ifaceList?.descendantsOfType('scoped_type_identifier') ?? []).map(t => t.text));
    facts.nodes.push({
      nodeType: 'ApexClass',
      name: cls.childForFieldName('name')?.text ?? '',
      superclass: cls.childForFieldName('superclass')?.descendantsOfType('type_identifier')[0]?.text ?? null,
      interfaces,
      annotations: annotations.map(a => a.name),
      isTest,
      startLine: cls.startPosition.row + 1,
    });
    // APEX-02: methods inside class body
    const body = cls.childForFieldName('body');
    for (const method of (body?.descendantsOfType('method_declaration') ?? [])) {
      const mMods = method.childForFieldName('modifiers');
      const signatureHead = (method.text ?? '').split('(')[0].toLowerCase();
      const modsNorm = ((mMods?.text ?? '') + ' ' + signatureHead).toLowerCase();
      const modChildren = (mMods?.descendantsOfType('modifier') ?? []).map(m => m.text.toLowerCase());
      const mAnnotations = (mMods?.descendantsOfType('annotation') ?? []).map(a =>
        a.descendantsOfType('identifier')[0]?.text ?? '');
      const visibility = modChildren.find(m => ['public', 'private', 'protected', 'global'].includes(m))
        ?? (modsNorm.includes('public') ? 'public'
          : modsNorm.includes('private') ? 'private'
            : modsNorm.includes('protected') ? 'protected'
              : modsNorm.includes('global') ? 'global'
                : 'package');
      const isStatic = modChildren.includes('static') || modsNorm.includes('static');
      const params = [];
      for (const p of (method.childForFieldName('parameters')?.descendantsOfType('formal_parameter') ?? [])) {
        params.push({ type: p.childForFieldName('type')?.text ?? '', name: p.childForFieldName('name')?.text ?? '' });
      }
      facts.nodes.push({
        nodeType: 'ApexMethod',
        name: method.childForFieldName('name')?.text ?? '',
        visibility, isStatic,
        returnType: method.childForFieldName('type')?.text ?? method.childForFieldName('void_type')?.text ?? 'void',
        parameters: params, annotations: mAnnotations,
        startLine: method.startPosition.row + 1,
      });
    }
  }

  // APEX-03: SOQL — query_expression → soql_query_body (NOT soql_query)
  for (const q of root.descendantsOfType('query_expression')) {
    const outerBody = q.descendantsOfType('soql_query_body')[0];
    if (!outerBody) continue;
    const fromObjects = outerBody.descendantsOfType('from_clause')
      .flatMap(f => f.descendantsOfType('storage_identifier').map(s => s.text));
    const selectFields = (outerBody.descendantsOfType('select_clause')[0]
      ?.descendantsOfType('field_identifier') ?? []).map(f => f.text);
    const whereFields = (outerBody.descendantsOfType('where_clause')[0]
      ?.descendantsOfType('field_identifier') ?? []).map(f => f.text);
    const subqueryBodies = q.descendantsOfType('soql_query_body').slice(1);
    const subqueryObjects = subqueryBodies.flatMap(b =>
      b.descendantsOfType('from_clause').flatMap(f =>
        f.descendantsOfType('storage_identifier').map(s => s.text)));
    facts.potential_refs.push({
      refType: 'SOQL', fromObjects, selectFields, whereFields, subqueryObjects,
      startLine: q.startPosition.row + 1, contextSnippet: q.text.substring(0, 120),
    });
  }

  // APEX-04: DML — namedChildren[0] NOT childForFieldName('dml_type')
  for (const dml of root.descendantsOfType('dml_expression')) {
    const dmlType = dml.namedChildren[0]?.text ?? 'unknown';
    const secondChild = dml.namedChildren[1];
    let targetType = null;
    if (secondChild?.type === 'object_creation_expression') {
      targetType = secondChild.childForFieldName('type')?.text;
    }
    facts.potential_refs.push({
      refType: 'DML', dmlType, targetType,
      startLine: dml.startPosition.row + 1, contextSnippet: dml.text.substring(0, 80),
    });
  }

  // APEX-05/06/07/08: method_invocation
  const systemClasses = new Set(['Database', 'Schema', 'System', 'Math', 'String', 'Date',
    'DateTime', 'Limits', 'Test', 'UserInfo', 'ApexPages', 'PageReference']);
  for (const mi of root.descendantsOfType('method_invocation')) {
    const objNode = mi.childForFieldName('object');
    const nameNode = mi.childForFieldName('name');
    if (!objNode || !nameNode) continue;
    const objText = objNode.text;
    const methodName = nameNode.text;
    const snippet = mi.text.substring(0, 100);
    const line = mi.startPosition.row + 1;

    // APEX-07: EventBus.publish
    if (objText === 'EventBus' && methodName === 'publish') {
      const args = mi.descendantsOfType('object_creation_expression');
      const eventType = args[0]?.childForFieldName('type')?.text ?? 'unknown';
      facts.potential_refs.push({ refType: 'PUBLISHES_EVENT', eventType, startLine: line, contextSnippet: snippet });
      continue;
    }

    // APEX-08: external namespace calls
    if (objText.includes('__') || objText.includes('.')) {
      facts.potential_refs.push({
        refType: 'CALLS_EXTERNAL',
        namespace: objText.split('.')[0],
        startLine: line,
        contextSnippet: snippet,
      });
      continue;
    }

    // APEX-06: Custom Setting accessors
    if (objText.endsWith('__c')) {
      facts.potential_refs.push({
        refType: 'READS_CUSTOM_SETTING',
        settingType: objText,
        method: methodName,
        startLine: line,
        contextSnippet: snippet,
      });
      continue;
    }

    // APEX-06: Custom Metadata accessors
    if (objText.endsWith('__mdt')) {
      facts.potential_refs.push({
        refType: 'READS_CUSTOM_METADATA',
        metadataType: objText,
        method: methodName,
        startLine: line,
        contextSnippet: snippet,
      });
      continue;
    }

    // Skip known system classes for CALLS detection
    if (!systemClasses.has(objText) && objNode.type === 'identifier') {
      // APEX-05: cross-class call
      facts.potential_refs.push({ refType: 'CALLS_CLASS_METHOD', targetClass: objText, method: methodName, startLine: line, contextSnippet: snippet });
    }
  }

  // APEX-06: Custom Label — field_access (separate loop)
  for (const fa of root.descendantsOfType('field_access')) {
    const faObj = fa.childForFieldName('object');
    const faField = fa.childForFieldName('field')?.text;
    if (!faField) continue;
    // System.Label.XXX: object is field_access where inner field == 'Label'
    if (faObj?.type === 'field_access' && faObj.childForFieldName('field')?.text === 'Label') {
      facts.potential_refs.push({ refType: 'READS_LABEL', labelName: faField, startLine: fa.startPosition.row + 1 });
    }
    // Label.XXX: object is identifier 'Label'
    if (faObj?.type === 'identifier' && faObj?.text === 'Label') {
      facts.potential_refs.push({ refType: 'READS_LABEL', labelName: faField, startLine: fa.startPosition.row + 1 });
    }
  }

  // APEX-09: picklist comparison — binary_expression
  for (const be of root.descendantsOfType('binary_expression')) {
    const left = be.childForFieldName('left');
    const right = be.childForFieldName('right');
    if (!left || !right) continue;
    if (left.type !== 'field_access' || right.type !== 'string_literal') continue;
    const fieldName = left.childForFieldName('field')?.text;
    const varName = left.childForFieldName('object')?.text;
    const comparand = right.text.replace(/^'|'$/g, '');
    if (fieldName) {
      facts.potential_refs.push({
        refType: 'PICKLIST_COMPARISON', varName, fieldName, comparand,
        startLine: be.startPosition.row + 1, contextSnippet: be.text.substring(0, 80),
      });
    }
  }

  return facts;
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
    writeResponse({ requestId: msg.requestId, type: 'pong' });
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
      writeResponse({
        requestId: msg.requestId,
        ok: false,
        error: 'memory_ceiling',
        payload: null,
      });
      process.exit(0);
    }

    const content = typeof msg.fileContent === 'string'
      ? msg.fileContent
      : fs.readFileSync(msg.filePath, 'utf8');
    const tree = apexParser.parse(content);
    const root = tree.rootNode;

    // APEX-10 guard: hasError is a PROPERTY (boolean) in WASM API — NOT a method
    if (root.hasError) {
      process.stderr.write('[worker] parse error in ' + msg.filePath + '\n');
      writeResponse({
        requestId: msg.requestId,
        ok: false,
        error: 'parse_error',
        payload: null,
      });
      return;
    }

    const payload = extractRawFacts(root, msg.filePath);
    writeResponse({
      requestId: msg.requestId,
      ok: true,
      payload,
    });
  } catch (e) {
    process.stderr.write('[worker] exception: ' + e.message + '\n');
    writeResponse({
      requestId: msg.requestId,
      ok: false,
      error: e.message,
      payload: null,
    });
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
