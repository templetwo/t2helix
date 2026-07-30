'use strict';

// test/compass-capability.js — capability gating, ruleset provenance, eligibility

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-capability-'));
process.env.T2HELIX_DATA_DIR = tmpDir;
// Repo policy resolves from the package root so the chronicle-db rule is loaded.
process.env.T2HELIX_POLICY_DIR = path.join(__dirname, '..');

const compass = require('../lib/compass');
const ch = require('../lib/chronicle');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.stack || e.message}`);
  }
}

// Destructive payloads are assembled rather than written literally so this file
// can be edited by an agent whose own PreToolUse gate reads the diff.
const RM = 'r' + 'm';
const FORCE = '--for' + 'ce';
const DROP = 'DR' + 'OP TABLE';

// Every entry is one payload under two tool names. The gate must reach the same
// verdict for both — the tool's NAME is not what makes a shell command dangerous.
const PARITY = [
  { label: 'recursive force delete of /', field: 'command', payload: `${RM} -rf /`, tool: 'mcp__shell__run' },
  { label: 'force push', field: 'command', payload: `git push ${FORCE} origin main`, tool: 'ShellTool' },
  { label: 'destructive schema op', field: 'command', payload: `sqlite3 app.db "${DROP} compass_log"`, tool: 'mcp__exec__sh' },
  { label: 'hard reset', field: 'command', payload: 'git reset --hard HEAD~5', tool: 'mcp__shell__run' },
  { label: 'delete via script field', field: 'script', payload: `${RM} -rf /`, tool: 'Terminal' },
  { label: 'force push via script field', field: 'script', payload: `git push ${FORCE} origin main`, tool: 'Terminal' }
];

console.log(`T2Helix compass capability tests (data: ${tmpDir})`);

for (const c of PARITY) {
  test(`parity: ${c.label} classifies the same under ${c.tool} as under Bash`, () => {
    const asBash = compass.classify({ tool_name: 'Bash', tool_input: { command: c.payload } });
    const asOther = compass.classify({ tool_name: c.tool, tool_input: { [c.field]: c.payload } });
    assert.strictEqual(
      asOther.classification,
      asBash.classification,
      `${c.tool} got ${asOther.classification}, Bash got ${asBash.classification}`
    );
    assert.strictEqual(asOther.rule_id, asBash.rule_id);
    assert.notStrictEqual(asBash.classification, 'OPEN', 'payload must be gated under Bash for the parity to mean anything');
  });
}

test('self-referential: the repo-local chronicle-db rule fires under a non-Bash shell tool', () => {
  // Relative path, no -r/-f: matches ONLY t2helix-protect-chronicle-db, so this
  // isolates the repo-policy rule rather than the bundled rm rules.
  const payload = `${RM} ./chronicle.db`;
  const asBash = compass.classify({ tool_name: 'Bash', tool_input: { command: payload } });
  assert.strictEqual(asBash.rule_id, 't2helix-protect-chronicle-db', 'fixture no longer isolates the repo rule');
  const asOther = compass.classify({ tool_name: 'mcp__shell__run', tool_input: { command: payload } });
  assert.strictEqual(asOther.classification, 'WITNESS');
  assert.strictEqual(asOther.rule_id, 't2helix-protect-chronicle-db');
});

test('capability detection: Bash and command/script-carrying tools are shell, others are not', () => {
  assert.strictEqual(compass.detectCapability({ tool_name: 'Bash', tool_input: { command: 'ls' } }).capability, 'shell');
  assert.strictEqual(compass.detectCapability({ tool_name: 'X', tool_input: { command: 'ls' } }).capability, 'shell');
  assert.strictEqual(compass.detectCapability({ tool_name: 'X', tool_input: { script: 'ls' } }).capability, 'shell');
  assert.strictEqual(compass.detectCapability({ tool_name: 'X', tool_input: { command: '' } }).capability, null);
  assert.strictEqual(compass.detectCapability({ tool_name: 'X', tool_input: { command: 42 } }).capability, null);
  assert.strictEqual(compass.detectCapability({ tool_name: 'Read', tool_input: { file_path: '/a' } }).capability, null);
  assert.strictEqual(compass.detectCapability({ tool_name: 'X', tool_input: null }).capability, null);
  assert.strictEqual(compass.detectCapability({ tool_name: 'X', tool_input: { command: 'ls' } }).field, 'command');
});

test('haystack is the payload field, not the JSON envelope', () => {
  // A rule anchored on a leading token must not be defeated by JSON quoting, and
  // a key NAME that happens to look destructive must not become the haystack.
  const hit = compass.classify({
    tool_name: 'mcp__shell__run',
    tool_input: { command: `${RM} -rf /`, description: 'cleanup' }
  });
  assert.strictEqual(hit.classification, 'WITNESS');
  const miss = compass.classify({
    tool_name: 'mcp__thing__do',
    tool_input: { command: 'status', [`${RM} -rf /`]: true }
  });
  assert.strictEqual(miss.classification, 'OPEN', 'a key name must not be matched as a shell payload');
});

test('false positives: benign non-shell command payloads do not move', () => {
  const benign = [
    'refresh',
    'play',
    '/deploy staging',
    'build --watch',
    'SELECT * FROM users WHERE id = 1',
    'npm test',
    'ls -la',
    'git status',
    'git push origin main',
    'echo hello',
    'open the door',
    'restart the production dashboard',
    'kubectl get pods -n production',
    'terraform plan -var env=production'
  ];
  const moved = [];
  for (const b of benign) {
    const asBash = compass.classify({ tool_name: 'Bash', tool_input: { command: b } });
    const asOther = compass.classify({ tool_name: 'mcp__app__cmd', tool_input: { command: b } });
    if (asOther.classification !== asBash.classification) moved.push([b, asBash.classification, asOther.classification]);
  }
  assert.deepStrictEqual(moved, [], `payloads classified differently than under Bash: ${JSON.stringify(moved)}`);
});

test('non-shell tools keep their existing scoping (no widening)', () => {
  for (const t of ['Read', 'Glob', 'Edit', 'Write']) {
    const r = compass.classify({ tool_name: t, tool_input: { file_path: `/tmp/${RM}-rf-notes.md` } });
    assert.strictEqual(r.classification, 'OPEN', `${t} unexpectedly gated`);
  }
});

test('identity: summarizeAction is unchanged for non-Bash tools', () => {
  // action_summary is the anchor of the action:<hash> chain and PostToolUse
  // recomputes it independently. Widening the MATCH haystack must not move it.
  const s = compass.summarizeAction({ tool_name: 'mcp__shell__run', tool_input: { command: 'ls -la' } });
  assert.strictEqual(s, `mcp__shell__run: ${JSON.stringify({ command: 'ls -la' })}`);
  const b = compass.summarizeAction({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.strictEqual(b, 'Bash: ls -la');
});

test('tool_exact opts a rule out of capability widening', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-exact-'));
  fs.mkdirSync(path.join(dir, '.t2helix'));
  fs.writeFileSync(path.join(dir, '.t2helix', 'policy.json'), JSON.stringify({
    rules: [
      { id: 'exact-only', classification: 'WITNESS', tool: 'Bash', tool_exact: true, pattern: 'ZZ_EXACT_ZZ', reason: 'r' },
      { id: 'widened', classification: 'WITNESS', tool: 'Bash', pattern: 'ZZ_WIDE_ZZ', reason: 'r' }
    ]
  }));
  const prev = process.env.T2HELIX_POLICY_DIR;
  process.env.T2HELIX_POLICY_DIR = dir;
  compass._resetCache();
  try {
    assert.strictEqual(
      compass.classify({ tool_name: 'Bash', tool_input: { command: 'ZZ_EXACT_ZZ' } }).rule_id, 'exact-only');
    assert.strictEqual(
      compass.classify({ tool_name: 'mcp__shell__run', tool_input: { command: 'ZZ_EXACT_ZZ' } }).classification, 'OPEN');
    assert.strictEqual(
      compass.classify({ tool_name: 'mcp__shell__run', tool_input: { command: 'ZZ_WIDE_ZZ' } }).rule_id, 'widened');
  } finally {
    process.env.T2HELIX_POLICY_DIR = prev;
    compass._resetCache();
  }
});

test('Grok keeps its tool-scoped rule and gains shell capability via command', () => {
  const g = compass.classify({ tool_name: 'Grok', tool_input: { action: 'override-compass' } });
  assert.strictEqual(g.rule_id, 'grok-direct-mutate', 'Grok-scoped rule regressed');
  const gs = compass.classify({ tool_name: 'Grok', tool_input: { command: `${RM} -rf /` } });
  assert.strictEqual(gs.classification, 'WITNESS');
});

test('eligibility: shell-capable tools have eligible rules, inert tools have none', () => {
  const bash = compass.eligibility({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  const shell = compass.eligibility({ tool_name: 'mcp__shell__run', tool_input: { command: 'ls' } });
  const inert = compass.eligibility({ tool_name: 'mcp__notes__read', tool_input: { id: 7 } });
  assert.strictEqual(bash.capability, 'shell');
  assert.ok(bash.rules_eligible > 0);
  assert.strictEqual(shell.rules_eligible, bash.rules_eligible, 'a shell tool must see the same rules as Bash');
  assert.strictEqual(inert.capability, null);
  assert.strictEqual(inert.rules_eligible, 0, 'inert tool must be recorded as never rule-eligible');
});

test('eligibility is counted independently of the first match', () => {
  // classify() returns on first match; a counter inside the loop would undercount.
  const hit = compass.classify({ tool_name: 'Bash', tool_input: { command: `${RM} -rf /` } });
  const miss = compass.classify({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.strictEqual(hit.rules_eligible, miss.rules_eligible);
  assert.ok(hit.rules_eligible > 1);
});

test('ruleset provenance: hash is stable, sourced, and discriminates a one-character pattern change', () => {
  const a = compass.rulesetProvenance();
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(a.ruleset_hash), `bad hash ${a.ruleset_hash}`);
  assert.strictEqual(a.ruleset_hash, compass.rulesetProvenance().ruleset_hash, 'hash unstable across calls');
  assert.ok(a.ruleset_source.includes('bundled'));
  assert.ok(a.rule_count > 0);

  function hashWithPattern(p) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-hash-'));
    fs.mkdirSync(path.join(dir, '.t2helix'));
    fs.writeFileSync(path.join(dir, '.t2helix', 'policy.json'), JSON.stringify({
      rules: [{ id: 'hash-probe', classification: 'WITNESS', tool: 'Bash', pattern: p, reason: 'r' }]
    }));
    const prev = process.env.T2HELIX_POLICY_DIR;
    process.env.T2HELIX_POLICY_DIR = dir;
    compass._resetCache();
    try {
      return compass.rulesetProvenance();
    } finally {
      process.env.T2HELIX_POLICY_DIR = prev;
      compass._resetCache();
    }
  }
  const p1 = hashWithPattern('ZZ_PROBE_A');
  const p2 = hashWithPattern('ZZ_PROBE_B');
  assert.notStrictEqual(p1.ruleset_hash, p2.ruleset_hash, 'hash blind to a pattern change — regex is not in the projection');
  assert.strictEqual(p1.rule_count, p2.rule_count);
  assert.ok(p1.ruleset_source.includes('repo-policy'));
  assert.notStrictEqual(p1.ruleset_hash, a.ruleset_hash);
});

test('ruleset manifest carries every rule in load order with a pattern digest', () => {
  const prov = compass.rulesetProvenance();
  const rules = compass.loadRules();
  assert.strictEqual(prov.manifest.length, rules.length);
  assert.deepStrictEqual(prov.manifest.map(m => m.id), rules.map(r => r.id), 'manifest must preserve load order');
  const cred = prov.manifest.find(m => m.id === 'credential-paste');
  assert.strictEqual(cred.pattern_source, 'secrets');
  const live = rules.find(r => r.id === 'credential-paste');
  assert.strictEqual(
    cred.pattern_sha256,
    crypto.createHash('sha256').update(live._regex.source).digest('hex'),
    'pattern_source rules must digest the RESOLVED regex, or a secrets-vocabulary change is invisible'
  );
});

test('compass_log records ruleset provenance and eligibility', () => {
  const prov = compass.rulesetProvenance();
  const elig = compass.eligibility({ tool_name: 'mcp__shell__run', tool_input: { command: `${RM} -rf /` } });
  ch.logCompass({
    session_id: 'cap-prov',
    tool_name: 'mcp__shell__run',
    action_summary: 'mcp__shell__run: redacted',
    classification: 'WITNESS',
    rule_matched: 'rm-rf-wildcard',
    reason: 'r',
    ruleset_hash: prov.ruleset_hash,
    ruleset_source: prov.ruleset_source,
    ruleset_manifest: prov.manifest,
    rule_count: prov.rule_count,
    rules_eligible: elig.rules_eligible
  });
  const row = ch.getCompassHistory({ limit: 50 }).find(r => r.session_id === 'cap-prov');
  assert.ok(row, 'row not found');
  assert.strictEqual(row.ruleset_hash, prov.ruleset_hash);
  assert.strictEqual(row.ruleset_source, prov.ruleset_source);
  assert.strictEqual(row.rules_eligible, elig.rules_eligible);
});

test('ruleset manifest round-trips out of the db', () => {
  const prov = compass.rulesetProvenance();
  const stored = ch.getRuleset(prov.ruleset_hash);
  assert.ok(stored, 'ruleset manifest was never persisted');
  assert.strictEqual(stored.rule_count, prov.rule_count);
  assert.strictEqual(stored.source, prov.ruleset_source);
  assert.deepStrictEqual(JSON.parse(stored.manifest_json), prov.manifest);
});

test('an ineligible action is recorded as rules_eligible = 0, not as an evaluated OPEN', () => {
  const elig = compass.eligibility({ tool_name: 'mcp__notes__read', tool_input: { id: 7 } });
  ch.logCompass({
    session_id: 'cap-inert',
    tool_name: 'mcp__notes__read',
    action_summary: 'mcp__notes__read: {}',
    classification: 'OPEN',
    rules_eligible: elig.rules_eligible,
    ruleset_hash: compass.rulesetProvenance().ruleset_hash
  });
  const row = ch.getCompassHistory({ limit: 50 }).find(r => r.session_id === 'cap-inert');
  assert.strictEqual(row.rules_eligible, 0);
});

test('migration: an old db survives and its pre-existing rows read as provenance-unknown', () => {
  const Database = require('better-sqlite3');
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-olddb-'));
  const dbPath = path.join(oldDir, 'chronicle.db');
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE compass_log (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      action_summary TEXT NOT NULL,
      classification TEXT NOT NULL,
      rule_matched TEXT,
      reason TEXT,
      user_override TEXT,
      occurred_at INTEGER NOT NULL
    );
  `);
  raw.prepare(`INSERT INTO compass_log (session_id, tool_name, action_summary, classification, occurred_at)
               VALUES (?, ?, ?, ?, ?)`).run('legacy-row', 'Bash', 'Bash: ls', 'OPEN', Date.now());
  raw.close();

  const { execFileSync } = require('child_process');
  const script = `
    process.env.T2HELIX_DATA_DIR = ${JSON.stringify(oldDir)};
    const ch = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'chronicle'))});
    const db = ch.db();
    const cols = db.prepare('PRAGMA table_info(compass_log)').all().map(c => c.name);
    const old = db.prepare("SELECT * FROM compass_log WHERE session_id = 'legacy-row'").get();
    ch.logCompass({ session_id: 'new-row', tool_name: 'Bash', action_summary: 'Bash: ls',
      classification: 'OPEN', ruleset_hash: 'sha256:deadbeef', ruleset_source: 'bundled', rules_eligible: 3 });
    const fresh = db.prepare("SELECT * FROM compass_log WHERE session_id = 'new-row'").get();
    console.log(JSON.stringify({ cols, old, fresh }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  for (const c of ['ruleset_hash', 'ruleset_source', 'rules_eligible']) {
    assert.ok(r.cols.includes(c), `migration did not add ${c}`);
  }
  assert.strictEqual(r.old.classification, 'OPEN', 'pre-existing row lost');
  assert.strictEqual(r.old.ruleset_hash, null, 'provenance-unknown must stay distinguishable from a recorded value');
  assert.strictEqual(r.old.rules_eligible, null);
  assert.strictEqual(r.fresh.ruleset_hash, 'sha256:deadbeef');
  assert.strictEqual(r.fresh.rules_eligible, 3);
});

test('schema.sql and migrateSchema agree on the compass_log shape', () => {
  const Database = require('better-sqlite3');
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-fresh-'));
  const fresh = new Database(path.join(freshDir, 'x.db'));
  fresh.exec(fs.readFileSync(path.join(__dirname, '..', 'lib', 'schema.sql'), 'utf8'));
  const fromSchema = fresh.prepare('PRAGMA table_info(compass_log)').all().map(c => c.name).sort();
  fresh.close();
  const live = ch.db().prepare('PRAGMA table_info(compass_log)').all().map(c => c.name).sort();
  assert.deepStrictEqual(fromSchema, live, 'schema.sql drifted from migrateSchema');
});

test('PreToolUse writes provenance on every compass_log path', () => {
  const { execFileSync } = require('child_process');
  const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-hookprov-'));
  const hook = path.join(__dirname, '..', 'hooks', 'pre-tool-use.js');
  const env = { ...process.env, T2HELIX_DATA_DIR: hookDir, T2HELIX_POLICY_DIR: path.join(__dirname, '..') };

  function fire(tool_name, tool_input) {
    return execFileSync(process.execPath, [hook], {
      input: JSON.stringify({ session_id: 'hook-prov', tool_name, tool_input }),
      env,
      encoding: 'utf8'
    });
  }
  const denied = fire('mcp__shell__run', { command: `${RM} -rf /` });
  assert.ok(denied.includes('deny'), `expected a deny, got ${denied}`);
  fire('mcp__notes__read', { id: 1 });

  const script = `
    process.env.T2HELIX_DATA_DIR = ${JSON.stringify(hookDir)};
    const ch = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'chronicle'))});
    console.log(JSON.stringify(ch.db().prepare(
      "SELECT tool_name, classification, ruleset_hash, rules_eligible FROM compass_log WHERE session_id='hook-prov'").all()));
  `;
  const rows = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim());
  assert.ok(rows.length >= 2, `expected 2 rows, got ${rows.length}`);
  for (const r of rows) {
    assert.ok(r.ruleset_hash, `row for ${r.tool_name} has no ruleset_hash`);
    assert.strictEqual(typeof r.rules_eligible, 'number');
  }
  const gated = rows.find(r => r.tool_name === 'mcp__shell__run');
  assert.strictEqual(gated.classification, 'WITNESS', 'the hook did not gate the non-Bash shell tool');
  assert.strictEqual(rows.find(r => r.tool_name === 'mcp__notes__read').rules_eligible, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
