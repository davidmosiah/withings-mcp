/**
 * Contract gate for the JSON examples in README.md and docs/*.md.
 *
 * The README is the first thing a human sees, and its examples are read as
 * promises. `scripts/demo-contract-test.mjs` already locks `withings_demo` to
 * the real builders — this gate covers the other public surface, so a payload
 * example on the docs pages cannot drift away from what the server returns.
 *
 * Every fenced ```json block is extracted from the markdown here, at run time.
 * Nothing is copied into this file: copying an example into the test recreates
 * the same drift one layer up, where it is even easier to miss.
 *
 * Each block is classified, because the two kinds fail differently:
 *
 *   CONFIG  — an MCP client snippet (`mcpServers`). It is not tool output, so
 *             there is no payload to compare. What can rot is the package name
 *             and the command, so those are checked against package.json and
 *             against examples/claude-desktop.json.
 *
 *   PAYLOAD — anything else: presented as something a tool returns. Its key
 *             paths are compared against `buildDemoPayload().sample`, which
 *             demo-contract-test.mjs holds equal to the real builders in the
 *             same `npm test` run. So README -> demo -> real builders, with a
 *             gate on each link, and the comparison fails in both directions:
 *
 *               - a key in the README the server never returns -> invented
 *               - a key the server returns the README omits    -> incomplete
 *
 * Today the repo has two blocks and both are CONFIG: there is no payload
 * example to correct. The PAYLOAD branch is the tripwire that stops the next
 * one from being added unverified.
 *
 * Escape hatch: a `<!-- readme-example: config -->` comment in the three lines
 * above a fence marks JSON that is configuration rather than tool output (a
 * server.json snippet, say). It is deliberately explicit and reviewable — using
 * it to silence a real payload defeats the gate.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { buildDemoPayload } from '../dist/services/demo.js';

const CONFIG_MARKER = 'readme-example: config';
const LOOKBACK_LINES = 12;

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const binNames = Object.keys(pkg.bin ?? {});
const demoSamples = buildDemoPayload().sample;

const docFiles = existsSync('docs')
  ? readdirSync('docs')
      .filter((f) => f.endsWith('.md'))
      .map((f) => `docs/${f}`)
  : [];
const files = ['README.md', ...docFiles].filter((f) => existsSync(f));

/** Extract every fenced ```json block, with the lines above it for context. */
function extractJsonBlocks(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const blocks = [];
  let open = null;
  lines.forEach((line, index) => {
    const fence = line.match(/^```(\w*)\s*$/);
    if (open === null && fence) {
      open = { lang: fence[1], startLine: index + 1, body: [] };
      return;
    }
    if (open !== null && line.trim() === '```') {
      if (open.lang === 'json') {
        blocks.push({
          file,
          line: open.startLine,
          text: open.body.join('\n'),
          context: lines.slice(Math.max(0, open.startLine - 1 - LOOKBACK_LINES), open.startLine - 1)
        });
      }
      open = null;
      return;
    }
    if (open !== null) open.body.push(line);
  });
  return blocks;
}

function keyPaths(value, prefix = '', out = new Set()) {
  if (Array.isArray(value)) {
    // Union across elements: one record does not describe a collection.
    for (const item of value) keyPaths(item, `${prefix}[]`, out);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  for (const key of Object.keys(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.add(path);
    keyPaths(value[key], path, out);
  }
  return out;
}

const failures = [];
const fail = (block, message) => failures.push(`\n  ${block.file}:${block.line} — ${message}`);

/** CONFIG: not tool output. Check the claims it does make against reality. */
function checkConfigBlock(block, parsed) {
  const servers = parsed.mcpServers ?? {};
  for (const [name, entry] of Object.entries(servers)) {
    const tokens = [entry.command, ...(entry.args ?? [])].filter((t) => typeof t === 'string');
    const referencesPackage = tokens.some((t) => t === pkg.name || t.startsWith(`${pkg.name}@`));
    const referencesBin = tokens.some((t) => binNames.includes(t));
    if (!referencesPackage && !referencesBin) {
      fail(
        block,
        `the "${name}" server runs \`${tokens.join(' ')}\`, which is neither the published package ` +
          `"${pkg.name}" nor one of its bins (${binNames.join(', ')}). ` +
          `A reader copying this snippet gets a command that does not exist.`
      );
    }
  }
  return servers;
}

/** PAYLOAD: compare against the demo sample, which is locked to the builders. */
function checkPayloadBlock(block, parsed) {
  const mentioned = block.context.join('\n').match(/withings_[a-z_]+/g) ?? [];
  const toolName = [...mentioned].reverse().find((name) => name in demoSamples);

  if (!toolName) {
    fail(
      block,
      mentioned.length > 0
        ? `looks like tool output for ${[...new Set(mentioned)].join(', ')}, but the demo contract has ` +
            `no sample for it, so nothing can verify this example. Add the tool to src/services/demo.ts ` +
            `(scripts/demo-contract-test.mjs holds that file equal to the real builders).`
        : `is a JSON example with no tool named in the ${LOOKBACK_LINES} lines above it, so this gate cannot ` +
            `tell which output it claims to show. Name the tool near the example, or mark the block ` +
            `\`<!-- ${CONFIG_MARKER} -->\` if it is configuration rather than tool output.`
    );
    return;
  }

  const readmeSet = keyPaths(parsed);
  const realSet = keyPaths(JSON.parse(JSON.stringify(demoSamples[toolName])));
  const invented = [...readmeSet].filter((k) => !realSet.has(k)).sort();
  const missing = [...realSet].filter((k) => !readmeSet.has(k)).sort();

  if (invented.length > 0) {
    fail(
      block,
      `${invented.length} key(s) in the ${toolName} example that the server NEVER returns.\n` +
        `  A reader trusting these writes a parser for data that never arrives:\n` +
        invented.map((k) => `    - ${k}`).join('\n')
    );
  }
  if (missing.length > 0) {
    fail(
      block,
      `${missing.length} key(s) ${toolName} returns that the example omits.\n` +
        `  Readers will not know these exist:\n` +
        missing.map((k) => `    + ${k}`).join('\n')
    );
  }
  if (invented.length === 0 && missing.length === 0) {
    console.log(`PASS ${block.file}:${block.line} — ${toolName} example matches ${readmeSet.size} key paths`);
  }
}

const blocks = files.flatMap(extractJsonBlocks);
assert.ok(
  blocks.length > 0,
  'no ```json blocks found in README.md or docs/*.md — this gate would be vacuous; ' +
    'if the examples were deliberately removed, remove the gate in the same commit.'
);

const configsByFile = new Map();
let payloadCount = 0;

for (const block of blocks) {
  let parsed;
  try {
    parsed = JSON.parse(block.text);
  } catch (error) {
    fail(block, `is not valid JSON (${error.message}). Readers copy these blocks verbatim.`);
    continue;
  }

  const marked = block.context.slice(-3).some((line) => line.includes(CONFIG_MARKER));
  if (marked) {
    console.log(`SKIP ${block.file}:${block.line} — marked as configuration, not tool output`);
    continue;
  }

  if (parsed && typeof parsed === 'object' && 'mcpServers' in parsed) {
    const before = failures.length;
    configsByFile.set(`${block.file}:${block.line}`, checkConfigBlock(block, parsed));
    if (failures.length === before) {
      console.log(`PASS ${block.file}:${block.line} — client config points at the real published package`);
    }
    continue;
  }

  payloadCount += 1;
  checkPayloadBlock(block, parsed);
}

/**
 * The same config is documented in several places and shipped as a file. Two
 * surfaces declaring the same thing with nobody comparing them is how one of
 * them goes stale unnoticed.
 */
const shippedPath = 'examples/claude-desktop.json';
if (existsSync(shippedPath) && configsByFile.size > 0) {
  const shipped = JSON.parse(readFileSync(shippedPath, 'utf8')).mcpServers ?? {};
  for (const [where, servers] of configsByFile) {
    const docNames = Object.keys(servers).sort().join(',');
    const shippedNames = Object.keys(shipped).sort().join(',');
    if (docNames !== shippedNames) {
      failures.push(
        `\n  ${where} — declares servers [${docNames}] but ${shippedPath} ships [${shippedNames}].`
      );
      continue;
    }
    for (const [name, entry] of Object.entries(servers)) {
      const docCmd = JSON.stringify([entry.command, ...(entry.args ?? [])]);
      const shippedCmd = JSON.stringify([shipped[name].command, ...(shipped[name].args ?? [])]);
      if (docCmd !== shippedCmd) {
        failures.push(
          `\n  ${where} — the "${name}" command is ${docCmd} in the docs but ${shippedCmd} in ${shippedPath}.`
        );
      }
    }
  }
  if (failures.length === 0) console.log(`PASS docs client config matches ${shippedPath}`);
}

if (failures.length > 0) {
  console.error('\nFAIL documented JSON examples drifted from reality:');
  console.error(failures.join('\n'));
  console.error(
    '\nFix the markdown so the examples match what the server actually does.' +
      '\nDo not mark a real payload as configuration to silence this — that is how the drift got here.\n'
  );
  process.exit(1);
}

console.log(
  `\nreadme-example: ${blocks.length} JSON block(s) checked ` +
    `(${configsByFile.size} client config, ${payloadCount} tool payload)`
);
console.log(
  JSON.stringify({ ok: true, suite: 'readme-example', blocks: blocks.length, payloads: payloadCount })
);
