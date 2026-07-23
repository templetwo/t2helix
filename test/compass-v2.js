'use strict';

// test/compass-v2.js — semantic decisions, July 21 specimens, merge rules, leases

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-compass-v2-'));
process.env.T2HELIX_DATA_DIR = tmpDir;
// Default tests to enforce so semantic family migration is exercised.
process.env.T2HELIX_COMPASS_V2 = 'enforce';

const { classifySemantic, mergeDecisions, isMigratedRuleId } = require('../lib/compass-semantic');
const { classifyV2 } = require('../lib/compass-v2');
const { parseToIR } = require('../lib/action-ir');
const { renderDecision, MESSAGE_VERSION } = require('../lib/decision-message');
const legacy = require('../lib/compass');
const ch = require('../lib/chronicle');

const specimens = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'compass-v2-specimens.json'), 'utf8')
);

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

console.log('compass-v2');

// ── July 21 specimens (enforce mode) ─────────────────────────────────────────

for (const s of specimens.july21_specimens) {
  test(`july21: ${s.id} → ${s.desired}`, () => {
    const v2 = classifyV2(
      { tool_name: s.tool_name, tool_input: s.tool_input },
      { cwd: process.cwd() }
    );
    assert.strictEqual(
      v2.active.classification,
      s.desired,
      `got ${v2.active.classification} rule=${v2.active.rule_id} legacy=${v2.legacy.classification}/${v2.legacy.rule_id} semantic=${v2.semantic && v2.semantic.classification}/${v2.semantic && v2.semantic.rule_id}`
    );
    if (s.desired_rule) {
      assert.strictEqual(v2.active.rule_id, s.desired_rule);
    }
  });
}

// ── Adversarial floor (must not weaken) ──────────────────────────────────────

for (const s of specimens.adversarial_floor) {
  test(`adversarial: ${s.id} → ${s.desired}`, () => {
    const v2 = classifyV2(
      { tool_name: s.tool_name, tool_input: s.tool_input },
      { cwd: process.cwd() }
    );
    assert.strictEqual(
      v2.active.classification,
      s.desired,
      `got ${v2.active.classification} rule=${v2.active.rule_id} semantic=${JSON.stringify(v2.semantic)}`
    );
    if (s.desired_rule) {
      assert.strictEqual(v2.active.rule_id, s.desired_rule);
    }
  });
}

// ── Evidence contract ────────────────────────────────────────────────────────

test('non-OPEN semantic decision carries evidence + hash + parser_version', () => {
  const d = classifySemantic('Bash', { command: 'rm -f ./foo*' }, { cwd: process.cwd() });
  assert.strictEqual(d.classification, 'PAUSE');
  assert.ok(d.predicate_id);
  assert.ok(d.evidence);
  assert.ok(d.normalized_action_hash && d.normalized_action_hash.startsWith('sha256:'));
  assert.ok(d.parser_version);
});

test('message contract renders PAUSE banner', () => {
  const d = classifySemantic('Bash', { command: 'rm -f ./x*' }, { cwd: process.cwd() });
  const msg = renderDecision(d, { action_summary: 'rm -f ./x*', token: 'deadbeef' });
  assert.ok(msg.lines[0].includes('PAUSE'));
  assert.ok(msg.text.includes('token='));
  assert.strictEqual(msg.message_version, MESSAGE_VERSION);
});

test('message contract renders WITNESS as BLOCKED', () => {
  const d = classifySemantic('Bash', { command: 'rm -rf /' }, { cwd: process.cwd() });
  const msg = renderDecision(d, { action_summary: 'rm -rf /' });
  assert.ok(msg.lines[0].includes('BLOCKED'));
});

// ── Merge rules ──────────────────────────────────────────────────────────────

test('merge enforce: migrated false-positive clears to OPEN', () => {
  const leg = { classification: 'WITNESS', rule_id: 'rm-rf-wildcard', reason: 'legacy' };
  const sem = {
    classification: 'OPEN',
    rule_id: null,
    normalized_action_hash: 'sha256:abc',
    parser_version: 'action-ir/0.12.0'
  };
  const m = mergeDecisions(leg, sem, 'enforce');
  assert.strictEqual(m.active.classification, 'OPEN');
  assert.strictEqual(m.active.false_positive_cleared, 'rm-rf-wildcard');
});

test('merge enforce: non-migrated WITNESS stands when semantic OPEN', () => {
  const leg = { classification: 'WITNESS', rule_id: 'git-push-force', reason: 'force' };
  const sem = {
    classification: 'OPEN',
    rule_id: null,
    normalized_action_hash: 'sha256:abc',
    parser_version: 'action-ir/0.12.0'
  };
  const m = mergeDecisions(leg, sem, 'enforce');
  assert.strictEqual(m.active.classification, 'WITNESS');
  assert.strictEqual(m.active.rule_id, 'git-push-force');
});

test('merge shadow: legacy remains active', () => {
  const leg = { classification: 'WITNESS', rule_id: 'rm-rf-wildcard', reason: 'legacy' };
  const sem = { classification: 'OPEN', rule_id: null };
  const m = mergeDecisions(leg, sem, 'shadow');
  assert.strictEqual(m.active.classification, 'WITNESS');
});

test('isMigratedRuleId covers rm + credential', () => {
  assert.ok(isMigratedRuleId('rm-rf-wildcard'));
  assert.ok(isMigratedRuleId('credential-paste'));
  assert.ok(!isMigratedRuleId('git-push-force'));
});

// ── Shadow mode ──────────────────────────────────────────────────────────────

test('shadow mode keeps legacy authoritative on FP case', () => {
  const prev = process.env.T2HELIX_COMPASS_V2;
  process.env.T2HELIX_COMPASS_V2 = 'shadow';
  try {
    // A case where legacy may still fire; shadow must not change active if legacy fires
    const v2 = classifyV2(
      { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
      {}
    );
    assert.strictEqual(v2.mode, 'shadow');
    assert.strictEqual(v2.active.classification, 'WITNESS');
    assert.ok(v2.shadow);
  } finally {
    process.env.T2HELIX_COMPASS_V2 = prev;
  }
});

// ── Leases ───────────────────────────────────────────────────────────────────

test('safe-repeat lease arm / find / consume / revoke', () => {
  const ir = parseToIR('Bash', { command: 'npm test' }, { cwd: '/repo' });
  const sid = 'lease-test-' + Date.now();
  const armed = ch.armSafeRepeat({
    session_id: sid,
    normalized_action_hash: ir.normalized_action_hash,
    executable: 'npm',
    cwd: '/repo',
    parser_version: ir.parser_version,
    max_uses: 2,
    ttl_ms: 60_000
  });
  assert.ok(armed.lease_id);

  const found = ch.findSafeRepeatLease({
    session_id: sid,
    normalized_action_hash: ir.normalized_action_hash,
    parser_version: ir.parser_version,
    cwd: '/repo'
  });
  assert.ok(found);
  assert.strictEqual(found.lease_id, armed.lease_id);

  assert.ok(ch.consumeSafeRepeatLease(armed.lease_id));
  assert.ok(ch.consumeSafeRepeatLease(armed.lease_id));
  // max_uses=2 exhausted
  assert.ok(!ch.consumeSafeRepeatLease(armed.lease_id));

  const armed2 = ch.armSafeRepeat({
    session_id: sid,
    normalized_action_hash: ir.normalized_action_hash,
    executable: 'npm',
    cwd: '/repo',
    parser_version: ir.parser_version,
    max_uses: 5
  });
  const rev = ch.revokeSafeRepeat({ lease_id: armed2.lease_id });
  assert.ok(rev.ok);
  assert.ok(!ch.findSafeRepeatLease({
    session_id: sid,
    normalized_action_hash: ir.normalized_action_hash,
    parser_version: ir.parser_version,
    cwd: '/repo'
  }));
});

test('lease never covers WITNESS (leaseCovers)', () => {
  assert.ok(!ch.leaseCovers({ classification_ceiling: 'PAUSE' }, { classification: 'WITNESS' }));
  assert.ok(ch.leaseCovers({ classification_ceiling: 'PAUSE' }, { classification: 'PAUSE' }));
});

// ── Schema migration / log enrichment ────────────────────────────────────────

test('logCompass stores normalized_action_hash + shadow_json', () => {
  const ir = parseToIR('Bash', { command: 'ls' });
  const r = ch.logCompass({
    session_id: 'v2-log',
    tool_name: 'Bash',
    action_summary: 'Bash: ls',
    classification: 'OPEN',
    rule_matched: null,
    reason: null,
    normalized_action_hash: ir.normalized_action_hash,
    parser_version: ir.parser_version,
    message_version: MESSAGE_VERSION,
    shadow_json: { agree: true }
  });
  assert.ok(r && r.id);
  const rows = ch.getCompassHistory({ limit: 5 });
  // getCompassHistory may not SELECT new cols — query db directly
  const row = ch.db().prepare('SELECT normalized_action_hash, parser_version, shadow_json FROM compass_log WHERE id = ?').get(r.id);
  assert.strictEqual(row.normalized_action_hash, ir.normalized_action_hash);
  assert.strictEqual(row.parser_version, ir.parser_version);
  assert.ok(row.shadow_json);
});

test('pending confirmation stores semantic hash', () => {
  const ir = parseToIR('Bash', { command: 'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345' });
  const sid = 'pending-sem-' + Date.now();
  const p = ch.createPendingConfirmation({
    session_id: sid,
    action_summary: 'Bash: export ...',
    rule_matched: 'credential-paste',
    reason: 'cred',
    normalized_action_hash: ir.normalized_action_hash,
    parser_version: ir.parser_version
  });
  assert.strictEqual(p.normalized_action_hash, ir.normalized_action_hash);
  ch.approveConfirmation({ token: p.token });
  const found = ch.findApproval({
    session_id: sid,
    action_summary: 'different-summary-should-still-match-via-semantic',
    normalized_action_hash: ir.normalized_action_hash,
    parser_version: ir.parser_version
  });
  assert.ok(found, 'semantic identity should match approval');
});

// ── Legacy still works in isolation ──────────────────────────────────────────

test('legacy classify still WITNESS on rm -rf wildcard', () => {
  const r = legacy.classify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/foo/*' } });
  assert.strictEqual(r.classification, 'WITNESS');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
