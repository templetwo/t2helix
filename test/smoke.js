'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-smoke-'));
process.env.T2HELIX_DATA_DIR = tmpDir;

const ch = require('../lib/chronicle');
const compass = require('../lib/compass');

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${name}: ${e.message}`);
    fail++;
  }
}

console.log(`T2Helix smoke tests (data: ${tmpDir})`);

test('chronicle: db initializes', () => {
  ch.db();
  assert.ok(fs.existsSync(path.join(tmpDir, 'chronicle.db')));
});

test('chronicle: record + recall', () => {
  const sid = 'test-session-1';
  ch.record({ session_id: sid, content: 'attention is required for relational-epistemic synergy', domain: 'iris', layer: 'ground_truth' });
  ch.record({ session_id: sid, content: 'falcon mamba shows no R×E interaction', domain: 'iris', layer: 'hypothesis' });
  ch.record({ session_id: sid, content: 'unrelated note about pizza', domain: 'misc' });
  const hits = ch.recall({ query: 'attention synergy', topK: 5 });
  assert.ok(hits.length >= 1, 'recall returned no hits');
  assert.ok(hits.some(h => h.content.includes('attention')), 'expected hit with "attention"');
});

test('chronicle: set_goal and getGoal roundtrip', () => {
  const sid = 'test-session-2';
  ch.setGoal({ session_id: sid, goal: 'ship T2Helix v0', why: 'validate felt difference', acceptance_criteria: ['hooks fire', 'recall returns context'] });
  const g = ch.getGoal(sid);
  assert.strictEqual(g.goal, 'ship T2Helix v0');
  assert.strictEqual(g.why, 'validate felt difference');
  assert.deepStrictEqual(g.acceptance_criteria, ['hooks fire', 'recall returns context']);
});

test('compass: rm -rf wildcard → WITNESS', () => {
  const r = compass.classify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/foo/*' } });
  assert.strictEqual(r.classification, 'WITNESS');
  assert.strictEqual(r.rule_id, 'rm-rf-wildcard');
});

test('compass: rm -rf / → WITNESS', () => {
  const r = compass.classify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  assert.strictEqual(r.classification, 'WITNESS');
});

test('compass: git push --force → WITNESS', () => {
  const r = compass.classify({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
  assert.strictEqual(r.classification, 'WITNESS');
});

test('compass: git push --force-with-lease → OPEN (safer variant)', () => {
  const r = compass.classify({ tool_name: 'Bash', tool_input: { command: 'git push --force-with-lease origin main' } });
  assert.strictEqual(r.classification, 'OPEN');
});

test('compass: drop table → WITNESS', () => {
  const r = compass.classify({ tool_name: 'Bash', tool_input: { command: 'sqlite3 db.sqlite "drop table users"' } });
  assert.strictEqual(r.classification, 'WITNESS');
});

test('compass: kubectl prod → WITNESS', () => {
  const r = compass.classify({ tool_name: 'Bash', tool_input: { command: 'kubectl apply -f deploy.yaml --context=prod' } });
  assert.strictEqual(r.classification, 'WITNESS');
});

test('compass: --no-verify on commit → WITNESS', () => {
  const r = compass.classify({ tool_name: 'Bash', tool_input: { command: 'git commit -m "fix" --no-verify' } });
  assert.strictEqual(r.classification, 'WITNESS');
});

test('compass: ls -la → OPEN (no rule fires)', () => {
  const r = compass.classify({ tool_name: 'Bash', tool_input: { command: 'ls -la /tmp' } });
  assert.strictEqual(r.classification, 'OPEN');
});

test('compass: edit without goal → OPEN (edit-no-context moved to optional.json in v0.0.2)', () => {
  const r = compass.classify(
    { tool_name: 'Edit', tool_input: { file_path: '/tmp/x.js' } },
    { has_goal: false }
  );
  assert.strictEqual(r.classification, 'OPEN');
});

test('compass: edit with goal → OPEN', () => {
  const r = compass.classify(
    { tool_name: 'Edit', tool_input: { file_path: '/tmp/x.js' } },
    { has_goal: true }
  );
  assert.strictEqual(r.classification, 'OPEN');
});

test('compass: optional.json contains edit-no-context with graduation metadata', () => {
  const fs = require('fs');
  const path = require('path');
  const optional = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'rules', 'optional.json'), 'utf8'));
  const enc = optional.rules.find(r => r.id === 'edit-no-context');
  assert.ok(enc, 'edit-no-context should exist in optional.json');
  assert.ok(enc._graduation_prerequisite, 'optional rules must declare graduation prerequisite');
  assert.ok(enc._first_pulled_at, 'optional rules must record when first pulled');
});

test('compass: PEM private key in arg → PAUSE', () => {
  const r = compass.classify({ tool_name: 'Bash', tool_input: { command: 'echo "-----BEGIN OPENSSH PRIVATE KEY-----" > k' } });
  assert.strictEqual(r.classification, 'PAUSE');
});

test('chronicle: getState returns goal + threads + insights', () => {
  const sid = 'test-session-state';
  ch.setGoal({ session_id: sid, goal: 'state test' });
  ch.openThread({ question: 'why is x?', domain: 'meta' });
  ch.record({ session_id: sid, content: 'state-test insight', domain: 'meta' });
  const s = ch.getState(sid);
  assert.strictEqual(s.goal.goal, 'state test');
  assert.ok(s.open_threads.some(t => t.question === 'why is x?'));
  assert.ok(s.recent_insights.some(i => i.content === 'state-test insight'));
});

// ============================================================================
// Phase 1: session-state file (hooks → MCP server unified signature)
// ============================================================================

test('phase1: writeCurrentSession + readCurrentSession round-trip', () => {
  const sid = 'phase1-session-' + Date.now();
  ch.writeCurrentSession(sid);
  assert.strictEqual(ch.readCurrentSession(), sid);
});

test('phase1: writeCurrentSession ignores null/empty inputs defensively', () => {
  const before = ch.readCurrentSession();
  ch.writeCurrentSession(null);
  ch.writeCurrentSession('');
  ch.writeCurrentSession(undefined);
  assert.strictEqual(ch.readCurrentSession(), before, 'state file should be unchanged');
});

test('phase1: setGoal preserve-prior archives first goal as insight', () => {
  const sid = 'phase1-preserve-' + Date.now();
  ch.setGoal({ session_id: sid, goal: 'first goal text', why: 'first why', acceptance_criteria: ['crit-a', 'crit-b'] });
  ch.setGoal({ session_id: sid, goal: 'second goal text' });
  const archived = ch.recall({ query: 'archived-goal first goal', topK: 20 });
  const match = archived.find(h => h.content.includes('first goal text') && h.tags && h.tags.includes('archived-goal'));
  assert.ok(match, 'expected archived insight tagged archived-goal containing first goal text');
  assert.strictEqual(match.layer, 'reflection');
  assert.ok(match.content.includes('first why'), 'archived insight should include prior why');
  assert.ok(match.content.includes('crit-a'), 'archived insight should include prior acceptance_criteria');
});

test('phase1: setGoal idempotent re-set does NOT archive', () => {
  const sid = 'phase1-idempotent-' + Date.now();
  const goalText = 'stable goal text ' + Date.now();
  ch.setGoal({ session_id: sid, goal: goalText });
  ch.setGoal({ session_id: sid, goal: goalText });
  ch.setGoal({ session_id: sid, goal: goalText });
  const archived = ch.recall({ query: goalText, topK: 20 });
  const matches = archived.filter(h => h.tags && h.tags.includes('archived-goal') && h.content.includes(goalText));
  assert.strictEqual(matches.length, 0, 'idempotent re-set should produce no archives');
});

// ============================================================================
// Phase 1: getCompassHistory
// ============================================================================

test('phase1: getCompassHistory returns recent compass_log entries', () => {
  const sid = 'phase1-compass-' + Date.now();
  ch.logCompass({ session_id: sid, tool_name: 'Bash', action_summary: 'test-1', classification: 'WITNESS', rule_matched: 'rm-rf-wildcard', reason: 'r1' });
  ch.logCompass({ session_id: sid, tool_name: 'Bash', action_summary: 'test-2', classification: 'OPEN', rule_matched: null, reason: null });
  ch.logCompass({ session_id: sid, tool_name: 'Bash', action_summary: 'test-3', classification: 'PAUSE', rule_matched: 'credential-paste', reason: 'r3' });
  const entries = ch.getCompassHistory({ limit: 50 });
  assert.ok(entries.length >= 3, 'should return at least the 3 we just inserted');
});

test('phase1: getCompassHistory matched_only filters out OPEN nulls', () => {
  const all = ch.getCompassHistory({ limit: 100 });
  const matched = ch.getCompassHistory({ limit: 100, matched_only: true });
  assert.ok(matched.length <= all.length, 'matched_only should be a subset');
  assert.ok(matched.every(e => e.rule_matched !== null), 'every matched_only row must have rule_matched');
});

test('phase1: getCompassHistory classification filter narrows correctly', () => {
  const witness = ch.getCompassHistory({ limit: 100, classification: 'WITNESS' });
  assert.ok(witness.every(e => e.classification === 'WITNESS'), 'WITNESS filter returned non-WITNESS rows');
  const pause = ch.getCompassHistory({ limit: 100, classification: 'PAUSE' });
  assert.ok(pause.every(e => e.classification === 'PAUSE'), 'PAUSE filter returned non-PAUSE rows');
});

// ============================================================================
// Phase 2: pending_confirmations lifecycle
// ============================================================================

test('phase2: actionHash is deterministic and 32 chars', () => {
  const a = ch.actionHash('Bash: echo hello');
  const b = ch.actionHash('Bash: echo hello');
  const c = ch.actionHash('Bash: echo world');
  assert.strictEqual(a, b, 'same input must produce same hash');
  assert.notStrictEqual(a, c, 'different input must produce different hash');
  assert.strictEqual(a.length, 32, 'hash should be 32 chars (truncated sha256)');
});

test('phase2: createPendingConfirmation returns 16-char hex token', () => {
  const sid = 'phase2-create-' + Date.now();
  const p = ch.createPendingConfirmation({
    session_id: sid, action_summary: 'unique-action-' + Date.now(),
    rule_matched: 'credential-paste', reason: 'test'
  });
  assert.ok(p.token, 'must return a token');
  assert.strictEqual(p.token.length, 16, 'token should be 16 hex chars');
  assert.ok(/^[a-f0-9]{16}$/.test(p.token), 'token should be lowercase hex');
  assert.ok(p.expires_at > Date.now(), 'expires_at must be in the future');
});

test('phase2: tokens are unique across calls', () => {
  const sid = 'phase2-unique-' + Date.now();
  const tokens = new Set();
  for (let i = 0; i < 20; i++) {
    const p = ch.createPendingConfirmation({
      session_id: sid, action_summary: 'unique-' + i,
      rule_matched: 'test', reason: 't'
    });
    tokens.add(p.token);
  }
  assert.strictEqual(tokens.size, 20, 'all 20 tokens should be unique');
});

test('phase2: findApproval returns null when only pending (not approved) exists', () => {
  const sid = 'phase2-empty-' + Date.now();
  const action = 'never-seen-' + Date.now();
  ch.createPendingConfirmation({ session_id: sid, action_summary: action, rule_matched: 't', reason: 't' });
  const found = ch.findApproval({ session_id: sid, action_summary: action });
  assert.strictEqual(found, null, 'pending status should not be findable as approval');
});

test('phase2: approveConfirmation with valid token → ok:true', () => {
  const sid = 'phase2-approve-' + Date.now();
  const action = 'approval-test-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: action, rule_matched: 'r', reason: 'r' });
  const result = ch.approveConfirmation({ token: p.token });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.action_summary, action);
});

test('phase2: findApproval returns approved row after approval', () => {
  const sid = 'phase2-find-' + Date.now();
  const action = 'find-test-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: action, rule_matched: 'r', reason: 'r' });
  ch.approveConfirmation({ token: p.token });
  const found = ch.findApproval({ session_id: sid, action_summary: action });
  assert.ok(found, 'approval should be findable after approval');
  assert.strictEqual(found.status, 'approved');
});

test('phase2: consumeApproval makes approval single-use', () => {
  const sid = 'phase2-consume-' + Date.now();
  const action = 'consume-test-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: action, rule_matched: 'r', reason: 'r' });
  ch.approveConfirmation({ token: p.token });
  const found = ch.findApproval({ session_id: sid, action_summary: action });
  ch.consumeApproval(found.id);
  const after = ch.findApproval({ session_id: sid, action_summary: action });
  assert.strictEqual(after, null, 'consumed approval should not be findable');
});

test('phase2: approveConfirmation rejects bad token', () => {
  const result = ch.approveConfirmation({ token: 'not-a-real-token' });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error, 'should include error message');
});

test('phase2: approveConfirmation rejects empty/missing token', () => {
  assert.strictEqual(ch.approveConfirmation({}).ok, false);
  assert.strictEqual(ch.approveConfirmation({ token: '' }).ok, false);
  assert.strictEqual(ch.approveConfirmation({ token: null }).ok, false);
});

test('phase2: approveConfirmation rejects double-approval', () => {
  const sid = 'phase2-double-' + Date.now();
  const action = 'double-test-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: action, rule_matched: 'r', reason: 'r' });
  ch.approveConfirmation({ token: p.token });
  const second = ch.approveConfirmation({ token: p.token });
  assert.strictEqual(second.ok, false, 'second approval should fail');
});

test('phase2: cross-session isolation — approval in A invisible to B', () => {
  const sidA = 'phase2-iso-A-' + Date.now();
  const sidB = 'phase2-iso-B-' + Date.now();
  const action = 'isolation-test-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sidA, action_summary: action, rule_matched: 'r', reason: 'r' });
  ch.approveConfirmation({ token: p.token });
  const fromA = ch.findApproval({ session_id: sidA, action_summary: action });
  const fromB = ch.findApproval({ session_id: sidB, action_summary: action });
  assert.ok(fromA, 'approval must be visible from session A');
  assert.strictEqual(fromB, null, 'approval must be invisible from session B');
});

test('phase2: action_hash isolates different commands within same session', () => {
  const sid = 'phase2-actionhash-' + Date.now();
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: 'cmd-A', rule_matched: 'r', reason: 'r' });
  ch.approveConfirmation({ token: p.token });
  const sameAction = ch.findApproval({ session_id: sid, action_summary: 'cmd-A' });
  const otherAction = ch.findApproval({ session_id: sid, action_summary: 'cmd-B' });
  assert.ok(sameAction, 'approval should match its own action');
  assert.strictEqual(otherAction, null, 'approval should not match a different action');
});

test('phase2: listPendingConfirmations with session_id filter', () => {
  const sid = 'phase2-list-' + Date.now();
  ch.createPendingConfirmation({ session_id: sid, action_summary: 'list-1', rule_matched: 'r', reason: 'r' });
  ch.createPendingConfirmation({ session_id: sid, action_summary: 'list-2', rule_matched: 'r', reason: 'r' });
  const entries = ch.listPendingConfirmations({ session_id: sid, limit: 10 });
  assert.ok(entries.length >= 2, 'expected at least the 2 we just inserted');
  assert.ok(entries.every(e => e.session_id === sid), 'filter should return only matching session_id');
});

test('phase2: listPendingConfirmations without filter spans sessions', () => {
  const all = ch.listPendingConfirmations({ limit: 200 });
  const uniqueSessions = new Set(all.map(e => e.session_id));
  assert.ok(uniqueSessions.size > 1, 'unfiltered list should span sessions');
});

// ============================================================================
// Robustness: input validation
// ============================================================================

test('robustness: record rejects empty content', () => {
  assert.throws(() => ch.record({ session_id: 'r-empty', content: '' }), /non-empty string/);
});

test('robustness: record rejects whitespace-only content', () => {
  assert.throws(() => ch.record({ session_id: 'r-ws', content: '   \n\t  ' }), /non-empty string/);
});

test('robustness: record rejects non-string content', () => {
  assert.throws(() => ch.record({ session_id: 'r-num', content: 12345 }), /non-empty string/);
  assert.throws(() => ch.record({ session_id: 'r-null', content: null }), /non-empty string/);
  assert.throws(() => ch.record({ session_id: 'r-obj', content: { foo: 'bar' } }), /non-empty string/);
});

test('robustness: record rejects content over 100KB', () => {
  const huge = 'x'.repeat(100 * 1024 + 1);
  assert.throws(() => ch.record({ session_id: 'r-huge', content: huge }), /exceeds 102400 bytes/);
});

test('robustness: record accepts content right at 100KB boundary', () => {
  const atBoundary = 'x'.repeat(100 * 1024);
  // Should not throw
  ch.record({ session_id: 'r-boundary', content: atBoundary });
});

test('robustness: record still requires session_id', () => {
  assert.throws(() => ch.record({ content: 'valid content' }), /session_id required/);
});

// ============================================================================
// hook-io: shared stdin reader for hook scripts
// ============================================================================

test('hook-io: readStdin is exported and is a function', () => {
  const { readStdin } = require('../lib/hook-io');
  assert.strictEqual(typeof readStdin, 'function');
});

ch.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
