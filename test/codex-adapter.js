'use strict';

// Codex connector tests. Everything runs against isolated temp config, home,
// instructions, and chronicle paths; the real ~/.codex and shared DB are never touched.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-codex-'));
const dataDir = path.join(tmpRoot, 'chronicle');
process.env.T2HELIX_DATA_DIR = dataDir;

const chronicle = require('../lib/chronicle');
const codex = require('../lib/codex-adapter');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('record + recall use the shared chronicle with Codex provenance', () => {
  chronicle.writeCurrentSession('codex-test-session');
  const written = codex.codexRecord(
    'codex connector remembers the amber helix bridge',
    { layer: 'ground_truth', tags: ['connector-test'] }
  );
  assert.ok(written.id);

  const hits = codex.codexRecall('amber helix bridge', { topK: 5 });
  const hit = hits.find(row => row.id === written.id);
  assert.ok(hit, 'recorded Codex insight must be recallable');
  assert.ok(hit.tags.includes('source:codex'));
  const stored = chronicle.db()
    .prepare('SELECT session_id FROM insights WHERE id = ?')
    .get(written.id);
  assert.strictEqual(stored.session_id, 'codex-test-session');
});

test('boot returns goal + memory and states the hook gap', async () => {
  chronicle.setGoal({
    session_id: 'codex-test-session',
    goal: 'Ship a truthful Codex connector',
    why: 'Share continuity without false safety claims',
    acceptance_criteria: ['tests pass', 'hook gap documented']
  });

  const boot = await codex.codexBoot({ query: 'amber helix bridge' });
  assert.strictEqual(boot.status, 'booted');
  assert.strictEqual(boot.sessionId, 'codex-test-session');
  assert.strictEqual(boot.goal.goal, 'Ship a truthful Codex connector');
  assert.ok(boot.memoryCount >= 1);
  assert.strictEqual(boot.automaticRecall, false);
  assert.strictEqual(boot.compassEnforced, false);
  assert.match(boot.note, /no UserPromptSubmit or PreToolUse hooks/);
});

test('compass check classifies WITNESS but never claims to block', () => {
  const result = codex.codexCompassCheck({
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' }
  });
  assert.strictEqual(result.classification, 'WITNESS');
  assert.strictEqual(result.advisory, true);
  assert.strictEqual(result.enforced, false);
  assert.strictEqual(result.recommendation, 'STOP_AND_REQUEST_HUMAN_REVIEW');
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'blocked'));
  assert.match(result.note, /cannot deny/);
});

test('compass check returns normal judgment for OPEN actions', () => {
  const result = codex.codexCompassCheck('ls -la');
  assert.strictEqual(result.classification, 'OPEN');
  assert.strictEqual(result.enforced, false);
  assert.strictEqual(result.recommendation, 'PROCEED_WITH_NORMAL_JUDGMENT');
});

test('init preserves existing MCP servers/instructions and creates backups', () => {
  const codexDir = path.join(tmpRoot, 'codex-home', '.codex');
  const configPath = path.join(codexDir, 'config.toml');
  const instructionsPath = path.join(codexDir, 'instructions.md');
  fs.mkdirSync(codexDir, { recursive: true });

  const originalConfig = [
    'model = "gpt-test"',
    '',
    '[mcp_servers.node_repl]',
    'command = "/existing/node_repl"',
    'args = []',
    'startup_timeout_sec = 120',
    '',
    '[mcp_servers.computer-use]',
    'command = "/existing/computer-use"',
    'args = ["mcp"]',
    '',
    '[mcp_servers.pencil]',
    'command = "/existing/pencil"',
    'args = ["--agent", "codexCLI"]',
    ''
  ].join('\n');
  const originalInstructions = '# Existing operator instructions\n\nKeep this text.\n';
  fs.writeFileSync(configPath, originalConfig);
  fs.writeFileSync(instructionsPath, originalInstructions);

  const result = codex.codexInit({
    configPath,
    instructionsPath,
    dataDir,
    repoRoot: path.resolve(__dirname, '..'),
    nodeCommand: '/compatible/node20',
    startupTimeoutSec: 33
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.health.degraded, false);
  assert.strictEqual(result.configChanged, true);
  assert.strictEqual(result.instructionsChanged, true);
  assert.ok(result.configBackup && fs.existsSync(result.configBackup));
  assert.ok(result.instructionsBackup && fs.existsSync(result.instructionsBackup));
  assert.strictEqual(fs.readFileSync(result.configBackup, 'utf8'), originalConfig);
  assert.strictEqual(
    fs.readFileSync(result.instructionsBackup, 'utf8'),
    originalInstructions
  );

  const config = fs.readFileSync(configPath, 'utf8');
  for (const server of ['node_repl', 'computer-use', 'pencil']) {
    assert.ok(config.includes(`[mcp_servers.${server}]`), `${server} must survive init`);
  }
  assert.strictEqual((config.match(/\[mcp_servers\.t2helix\]/g) || []).length, 1);
  assert.ok(config.includes('command = "/compatible/node20"'));
  assert.ok(config.includes('"--transport", "stdio"'));
  assert.ok(config.includes(`T2HELIX_DATA_DIR = ${JSON.stringify(dataDir)}`));
  assert.ok(config.includes('startup_timeout_sec = 33'));

  const instructions = fs.readFileSync(instructionsPath, 'utf8');
  assert.ok(instructions.startsWith(originalInstructions.trimEnd()));
  assert.ok(instructions.includes('Keep this text.'));
  assert.match(instructions, /advisory, not enforced/);
  assert.match(instructions, /cannot technically block/);
});

test('init is byte-idempotent and does not duplicate managed blocks', () => {
  const codexDir = path.join(tmpRoot, 'codex-home', '.codex');
  const configPath = path.join(codexDir, 'config.toml');
  const instructionsPath = path.join(codexDir, 'instructions.md');
  const beforeConfig = fs.readFileSync(configPath, 'utf8');
  const beforeInstructions = fs.readFileSync(instructionsPath, 'utf8');

  const result = codex.codexInit({
    configPath,
    instructionsPath,
    dataDir,
    repoRoot: path.resolve(__dirname, '..'),
    nodeCommand: '/compatible/node20',
    startupTimeoutSec: 33
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.configChanged, false);
  assert.strictEqual(result.instructionsChanged, false);
  assert.strictEqual(result.configBackup, null);
  assert.strictEqual(result.instructionsBackup, null);
  assert.strictEqual(fs.readFileSync(configPath, 'utf8'), beforeConfig);
  assert.strictEqual(fs.readFileSync(instructionsPath, 'utf8'), beforeInstructions);
  assert.strictEqual((beforeConfig.match(/\[mcp_servers\.t2helix\]/g) || []).length, 1);
  assert.strictEqual((beforeInstructions.match(/T2HELIX CODEX CONNECTOR/g) || []).length, 2);
});

test('init replaces an unmarked legacy t2helix section without duplication', () => {
  const root = path.join(tmpRoot, 'legacy-init');
  const configPath = path.join(root, 'config.toml');
  const instructionsPath = path.join(root, 'instructions.md');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(configPath, [
    '[mcp_servers.t2helix]',
    'command = "old-node"',
    'args = ["old-server"]',
    '',
    '[mcp_servers.keep_me]',
    'command = "keep"',
    ''
  ].join('\n'));

  const result = codex.codexInit({
    configPath,
    instructionsPath,
    dataDir,
    repoRoot: path.resolve(__dirname, '..'),
    nodeCommand: '/compatible/node20'
  });
  assert.strictEqual(result.ok, true);
  const config = fs.readFileSync(configPath, 'utf8');
  assert.strictEqual((config.match(/\[mcp_servers\.t2helix\]/g) || []).length, 1);
  assert.ok(!config.includes('old-server'));
  assert.ok(config.includes('[mcp_servers.keep_me]'));
  assert.ok(config.includes('command = "keep"'));
});

(async () => {
  let passed = 0;
  let failed = 0;
  console.log(`T2Helix Codex adapter tests (root: ${tmpRoot})`);
  for (const entry of tests) {
    try {
      await entry.fn();
      passed++;
      console.log(`  PASS  ${entry.name}`);
    } catch (e) {
      failed++;
      console.error(`  FAIL  ${entry.name}: ${e.stack || e.message}`);
    }
  }
  try { chronicle.close(); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
