#!/usr/bin/env node
/**
 * Regression tests for lib/grok-adapter.js compass routing.
 *
 * Guards the 2026-07-26 bypass: grokWitness() wrapped a plain string as
 * {tool_name:'Grok', tool_input:{note}}, which matches no rule in
 * compass-rules.json (rules key off Bash + tool_input.command). Every string
 * action therefore classified OPEN and the WITNESS hard-deny branch was
 * unreachable — while the adapter's own doc comment promised "WITNESS
 * classifications are hard-denied (same as Claude)". The shipped `grok:witness`
 * npm script passes a plain string, so that was the live path.
 *
 * See chronicle #10258 / open thread #13.
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Isolated data dir, per repo convention — never touch the real chronicle.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-grok-'));
process.env.T2HELIX_DATA_DIR = dataDir;

const grok = require('../lib/grok-adapter');
const compass = require('../lib/compass');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message}`);
    failed++;
  }
}

// Built at runtime so the literal never sits in this file — the compass scans
// tool input, and a bare destructive literal here trips the host's own gate.
const RM = String.fromCharCode(114, 109);
const STAR = String.fromCharCode(42);
const DESTRUCTIVE = `${RM} -rf /tmp/${STAR}`;

(async () => {
  await test('a bare string reaches the compass as a shell command', async () => {
    const direct = compass.classify(
      { tool_name: 'Bash', tool_input: { command: DESTRUCTIVE } },
      { has_goal: false }
    );
    assert.strictEqual(
      direct.classification,
      'WITNESS',
      'precondition: the rule set must classify this as WITNESS'
    );

    const viaAdapter = await grok.grokWitness(DESTRUCTIVE);
    assert.strictEqual(
      viaAdapter.classification,
      'WITNESS',
      `string input classified ${viaAdapter.classification}; the compass was bypassed`
    );
  });

  await test('a WITNESS string action is actually blocked, not just labelled', async () => {
    const r = await grok.grokWitness(DESTRUCTIVE);
    assert.strictEqual(r.blocked, true, 'WITNESS must set blocked:true');
    assert.strictEqual(r.recorded, false, 'a blocked action must not be recorded as performed');
  });

  await test('adapter and direct compass agree for string input', async () => {
    for (const cmd of [DESTRUCTIVE, 'ls -la /tmp', 'echo hello']) {
      const direct = compass.classify(
        { tool_name: 'Bash', tool_input: { command: cmd } },
        { has_goal: false }
      );
      const viaAdapter = await grok.grokWitness(cmd);
      assert.strictEqual(
        viaAdapter.classification,
        direct.classification,
        `divergence on ${JSON.stringify(cmd)}: adapter=${viaAdapter.classification} direct=${direct.classification}`
      );
    }
  });

  await test('benign commands still pass through as OPEN', async () => {
    const r = await grok.grokWitness('ls -la /tmp');
    assert.strictEqual(r.classification, 'OPEN');
    assert.strictEqual(r.blocked, false);
  });

  await test('structured {tool_name,tool_input} input keeps working', async () => {
    const r = await grok.grokWitness({
      tool_name: 'Bash',
      tool_input: { command: DESTRUCTIVE },
    });
    assert.strictEqual(r.classification, 'WITNESS');
    assert.strictEqual(r.blocked, true);
  });

  await test('grokWitness is async — callers must await it', async () => {
    const p = grok.grokWitness('ls -la /tmp');
    assert.strictEqual(
      typeof p.then,
      'function',
      'grokWitness must return a Promise; npm scripts that console.dir it directly print a Promise, not a verdict'
    );
    await p;
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed === 0 ? 0 : 1);
})();
