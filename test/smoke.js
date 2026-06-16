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

test('chronicle: getState.recent_insights excludes META_DOMAINS (recall parity)', () => {
  const sid = 'test-session-meta-filter';
  ch.record({ session_id: sid, content: 'curated visible insight', domain: 'meta-filter-test' });
  ch.record({ session_id: sid, content: 'hook noise action entry', domain: 'session-action' });
  ch.record({ session_id: sid, content: 'hook noise synthesis entry', domain: 'session-synthesis' });
  const s = ch.getState(sid);
  assert.ok(s.recent_insights.some(i => i.content === 'curated visible insight'), 'curated insight should surface');
  assert.ok(!s.recent_insights.some(i => i.content === 'hook noise action entry'), 'session-action must be filtered from getState');
  assert.ok(!s.recent_insights.some(i => i.content === 'hook noise synthesis entry'), 'session-synthesis must be filtered from getState');
});

// ── audit fixes: FTS retrieval (A), atomic approval (E), compass rules (H) ───

test('recall: command-shaped query ranks by FTS similarity, not recency (criterion-2)', () => {
  const sid = 'fts-similarity';
  // 3 OLDER similar failures, then 5 NEWER unrelated successes.
  for (let i = 0; i < 3; i++) {
    ch.record({ session_id: sid, content: `[PostToolUse] Bash: git push origin feature-${i} --force`, domain: 'session-action', tags: ['outcome:failure'] });
  }
  for (let i = 0; i < 5; i++) {
    ch.record({ session_id: sid, content: `[PostToolUse] Bash: npm install left-pad-${i}`, domain: 'session-action', tags: ['outcome:success'] });
  }
  const hits = ch.recall({ query: 'Bash: git push origin main', topK: 10, include_meta: true });
  const gitHits = hits.filter(h => /git push origin feature/.test(h.content));
  assert.ok(gitHits.length >= 3, `expected the 3 similar git-push entries to surface, got ${gitHits.length}`);
  const firstGit = hits.findIndex(h => /git push origin feature/.test(h.content));
  const firstNpm = hits.findIndex(h => /npm install left-pad/.test(h.content));
  assert.ok(firstNpm === -1 || firstGit < firstNpm,
    'similar git-push ranks above newer unrelated npm (real FTS, not the recency fallback)');
});

test('recall: FTS-operator-laden query does not throw into the recency fallback', () => {
  ch.record({ session_id: 'fts-noerror', content: 'alpha bravo charlie-fts-probe', domain: 'fts-test' });
  const hits = ch.recall({ query: 'Bash: do-thing --flag (group) charlie-fts-probe', topK: 5 });
  assert.ok(hits.some(h => /charlie-fts-probe/.test(h.content)),
    'colon/hyphen/paren tokens are quoted as literals and still match real content');
});

test('recall: all-punctuation query returns a recency list rather than crashing', () => {
  ch.record({ session_id: 'fts-punct', content: 'punctuation fallback probe', domain: 'fts-test' });
  const hits = ch.recall({ query: '--- ::: ((( ', topK: 5 });
  assert.ok(Array.isArray(hits), 'a no-searchable-token query returns a list');
});

test('consumeApproval: atomic single-use — a second consume returns false (no double-spend)', () => {
  const sid = 'consume-atomic';
  const summary = 'Bash: echo api_key=secret';
  const { token } = ch.createPendingConfirmation({ session_id: sid, action_summary: summary });
  ch.approveConfirmation({ token });
  const approval = ch.findApproval({ session_id: sid, action_summary: summary });
  assert.ok(approval, 'approval found after approve');
  assert.strictEqual(ch.consumeApproval(approval.id), true, 'first consume claims the token');
  assert.strictEqual(ch.consumeApproval(approval.id), false, 'second consume is rejected');
});

test('compass: deploy-prod gates mutating prod ops but not read-only inspection', () => {
  const C = cmd => compass.classify({ tool_name: 'Bash', tool_input: { command: cmd } }).classification;
  // Read-only must pass — including the "deploy" resource shorthand that naively collides.
  assert.strictEqual(C('kubectl get pods -n production'), 'OPEN', 'read-only kubectl get not gated');
  assert.strictEqual(C('kubectl get deploy -n production'), 'OPEN', 'kubectl get deploy (resource) not gated');
  assert.strictEqual(C('kubectl logs -f deploy/app -n production'), 'OPEN', 'kubectl logs not gated');
  assert.strictEqual(C('aws s3 ls s3://prod-logs'), 'OPEN', 'read-only aws s3 ls not gated');
  // Mutating must gate — including verbs missed by a naive allowlist.
  assert.strictEqual(C('kubectl apply -f deploy.yaml -n production'), 'WITNESS', 'kubectl apply to prod gated');
  assert.strictEqual(C('kubectl edit deployment app -n production'), 'WITNESS', 'kubectl edit gated');
  assert.strictEqual(C('aws s3 cp ./build s3://prod-bucket/'), 'WITNESS', 'aws s3 cp to prod gated');
  assert.strictEqual(C('terraform destroy -target prod'), 'WITNESS', 'terraform destroy prod gated');
  assert.strictEqual(C('kubectl run nginx --image=x -n prod'), 'WITNESS', 'kubectl run gated');
  // Relay-review bypasses (newline hide + read-only-substring resource name) must still gate.
  assert.strictEqual(C('kubectl delete namespace prod\nkubectl get pods'), 'WITNESS', 'multiline cannot hide a mutation behind a later read-only line');
  assert.strictEqual(C('kubectl delete service get-prod -n prod'), 'WITNESS', 'a resource named get-prod cannot shield delete');
});

test('compass: previously-untested rule variants classify correctly', () => {
  const C = cmd => compass.classify({ tool_name: 'Bash', tool_input: { command: cmd } });
  assert.strictEqual(C('git reset --hard HEAD~3').rule_id, 'git-reset-hard', 'git reset --hard');
  assert.strictEqual(C('git push -f origin main').rule_id, 'git-push-force', 'git push -f short form');
  assert.strictEqual(C('export AWS_SECRET_ACCESS_KEY=AKIAEXAMPLE').classification, 'PAUSE', 'aws secret env var');
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

// ============================================================================
// outcome detection (helix substrate — criterion #1)
// PostToolUse uses these tags to mark whether the action succeeded or failed;
// the memory→compass coupling reads them when scoring future similar actions.
// ============================================================================

const { detectOutcome } = require('../lib/outcome');

test('outcome: Bash with clean stdout and empty stderr → success', () => {
  const r = detectOutcome('Bash', { stdout: '10 passed in 0.45s', stderr: '', interrupted: false });
  assert.strictEqual(r, 'success');
});

test('outcome: Bash with pytest FAILED in stdout → failure', () => {
  const r = detectOutcome('Bash', { stdout: 'test_foo FAILED\n1 passed, 1 failed', stderr: '', interrupted: false });
  assert.strictEqual(r, 'failure');
});

test('outcome: Bash with Python Traceback in stdout → failure', () => {
  const r = detectOutcome('Bash', {
    stdout: 'Traceback (most recent call last):\n  File "x.py", line 1, in <module>\n    raise ValueError()',
    stderr: '',
    interrupted: false
  });
  assert.strictEqual(r, 'failure');
});

test('outcome: Bash with "fatal:" in stderr → failure (git error shape)', () => {
  const r = detectOutcome('Bash', { stdout: '', stderr: 'fatal: not a git repository', interrupted: false });
  assert.strictEqual(r, 'failure');
});

test('outcome: Bash with deprecation warning in stderr → success (warning ≠ error)', () => {
  const r = detectOutcome('Bash', {
    stdout: 'installed 3 packages',
    stderr: 'npm warn deprecated foo@1.0.0',
    interrupted: false
  });
  assert.strictEqual(r, 'success');
});

test('outcome: any tool with interrupted=true → failure (universal signal)', () => {
  assert.strictEqual(detectOutcome('Bash', { stdout: '', stderr: '', interrupted: true }), 'failure');
  assert.strictEqual(detectOutcome('Edit', { interrupted: true }), 'failure');
});

test('outcome: Edit with object response → success', () => {
  const r = detectOutcome('Edit', { filePath: '/tmp/x.js', oldString: 'a', newString: 'b' });
  assert.strictEqual(r, 'success');
});

test('outcome: Write with object response → success', () => {
  const r = detectOutcome('Write', { filePath: '/tmp/x.js' });
  assert.strictEqual(r, 'success');
});

test('outcome: Edit with "Error: ..." string response → failure (defensive)', () => {
  const r = detectOutcome('Edit', 'Error: file not found');
  assert.strictEqual(r, 'failure');
});

test('outcome: unknown tool → null (do not tag what we cannot judge)', () => {
  assert.strictEqual(detectOutcome('NotebookEdit', { foo: 'bar' }), null);
  assert.strictEqual(detectOutcome('Read', { content: '...' }), null);
});

test('outcome: missing tool_response → null', () => {
  assert.strictEqual(detectOutcome('Bash', null), null);
  assert.strictEqual(detectOutcome('Bash', undefined), null);
});

test('outcome: Bash with non-object response → null (ambiguous)', () => {
  assert.strictEqual(detectOutcome('Bash', 'some string'), null);
});

// ============================================================================
// chronicle: recall tag filter (helix criterion #2 supporting feature)
// ============================================================================

test('recall: tag filter matches entries containing exact quoted tag token', () => {
  const sid = 'tag-filter-' + Date.now();
  const marker = 'tagq-' + Date.now();
  ch.record({ session_id: sid, content: `${marker} failure case`, tags: ['outcome:failure', 'bash'] });
  ch.record({ session_id: sid, content: `${marker} success case`, tags: ['outcome:success', 'bash'] });
  ch.record({ session_id: sid, content: `${marker} untagged`, tags: ['bash'] });
  const failureHits = ch.recall({ query: marker, topK: 10, tag: 'outcome:failure' });
  assert.ok(failureHits.length >= 1, 'should match the failure entry');
  assert.ok(failureHits.every(h => h.tags && h.tags.includes('outcome:failure')), 'every hit must carry the tag');
  assert.ok(!failureHits.some(h => h.tags && h.tags.includes('outcome:success')), 'success entry must be excluded');
});

test('recall: tag filter is exact (outcome:fail does NOT match outcome:failure)', () => {
  const sid = 'tag-exact-' + Date.now();
  const marker = 'tagex-' + Date.now();
  ch.record({ session_id: sid, content: `${marker} entry`, tags: ['outcome:failure'] });
  const hits = ch.recall({ query: marker, topK: 10, tag: 'outcome:fail' });
  assert.strictEqual(hits.length, 0, 'partial tag prefix should not match');
});

// ============================================================================
// coupling: memory → compass escalation policy (helix criterion #2)
// Pure tests — no DB. Hand the policy a base classification and a synthetic
// entry list and assert the upgrade behavior.
// ============================================================================

const { escalateByMemory, countOutcomes, MIN_SIMILAR, FAILURE_RATIO } = require('../lib/coupling');

function mkEntry(id, tags) {
  return { id, tags };
}

test('coupling: WITNESS classification is never escalated (rule decisions stand)', () => {
  const base = { classification: 'WITNESS', rule_id: 'rm-rf-wildcard', reason: 'hard deny' };
  const similar = [mkEntry(1, ['outcome:failure']), mkEntry(2, ['outcome:failure']), mkEntry(3, ['outcome:failure'])];
  const r = escalateByMemory(base, similar);
  assert.strictEqual(r.classification, 'WITNESS');
  assert.strictEqual(r.memory_escalated, false);
});

test('coupling: PAUSE classification is never escalated (memory cannot downgrade or skip)', () => {
  const base = { classification: 'PAUSE', rule_id: 'credential-paste', reason: 'soft deny' };
  const similar = [mkEntry(1, ['outcome:success']), mkEntry(2, ['outcome:success']), mkEntry(3, ['outcome:success'])];
  const r = escalateByMemory(base, similar);
  assert.strictEqual(r.classification, 'PAUSE');
  assert.strictEqual(r.memory_escalated, false);
});

test('coupling: OPEN stays OPEN below MIN_SIMILAR sample size', () => {
  const base = { classification: 'OPEN', rule_id: null, reason: null };
  const similar = [mkEntry(1, ['outcome:failure']), mkEntry(2, ['outcome:failure'])];  // total=2 < MIN_SIMILAR=3
  const r = escalateByMemory(base, similar);
  assert.strictEqual(r.classification, 'OPEN');
  assert.strictEqual(r.memory_escalated, false);
});

test('coupling: OPEN stays OPEN when failure ratio below threshold', () => {
  const base = { classification: 'OPEN', rule_id: null, reason: null };
  const similar = [
    mkEntry(1, ['outcome:success']), mkEntry(2, ['outcome:success']),
    mkEntry(3, ['outcome:success']), mkEntry(4, ['outcome:failure'])
  ];  // 1/4 = 0.25 failures, below 0.5
  const r = escalateByMemory(base, similar);
  assert.strictEqual(r.classification, 'OPEN');
  assert.strictEqual(r.memory_escalated, false);
});

test('coupling: OPEN → PAUSE when ≥50% of N≥3 outcome-tagged entries are failures', () => {
  const base = { classification: 'OPEN', rule_id: null, reason: null };
  const similar = [
    mkEntry(101, ['outcome:failure']), mkEntry(102, ['outcome:failure']),
    mkEntry(103, ['outcome:failure']), mkEntry(104, ['outcome:success'])
  ];  // 3/4 failures, ratio 0.75 ≥ 0.5
  const r = escalateByMemory(base, similar);
  assert.strictEqual(r.classification, 'PAUSE');
  assert.strictEqual(r.rule_id, 'memory:similar-failures');
  assert.strictEqual(r.memory_escalated, true);
  assert.ok(r.reason.includes('3/4'), 'reason should include the failure stats');
  assert.ok(r.reason.includes('#101'), 'reason should reference matched failure entry IDs');
});

test('coupling: untagged entries are ignored in the ratio (silence is safe)', () => {
  const base = { classification: 'OPEN', rule_id: null, reason: null };
  const similar = [
    mkEntry(1, ['outcome:failure']), mkEntry(2, ['outcome:failure']),
    mkEntry(3, ['outcome:failure']),
    // 5 untagged entries that should NOT dilute the ratio
    mkEntry(4, ['bash']), mkEntry(5, ['bash']), mkEntry(6, ['bash']),
    mkEntry(7, []), mkEntry(8, null)
  ];
  const r = escalateByMemory(base, similar);
  assert.strictEqual(r.classification, 'PAUSE', 'untagged should not block escalation');
  assert.ok(r.memory_stats.total === 3, 'total counts only outcome-tagged entries');
});

test('coupling: empty/null similar entries leaves classification untouched', () => {
  const base = { classification: 'OPEN', rule_id: null, reason: null };
  assert.strictEqual(escalateByMemory(base, []).classification, 'OPEN');
  assert.strictEqual(escalateByMemory(base, null).classification, 'OPEN');
  assert.strictEqual(escalateByMemory(base, undefined).classification, 'OPEN');
});

test('coupling: countOutcomes returns success/failure/total/failureEntries shape', () => {
  const entries = [
    mkEntry(1, ['outcome:success']),
    mkEntry(2, ['outcome:failure']),
    mkEntry(3, ['outcome:failure']),
    mkEntry(4, ['some-other-tag'])
  ];
  const r = countOutcomes(entries);
  assert.strictEqual(r.success, 1);
  assert.strictEqual(r.failure, 2);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.failureEntries.length, 2);
});

test('coupling: thresholds exported and have sensible MVP values', () => {
  assert.strictEqual(MIN_SIMILAR, 3, 'MIN_SIMILAR should be 3 for MVP');
  assert.strictEqual(FAILURE_RATIO, 0.5, 'FAILURE_RATIO should be 0.5 for MVP');
});

// ============================================================================
// compass → memory: recordCompassFire (helix criterion #3)
// PAUSE/WITNESS classifications get a high-intensity chronicle entry tagged
// with action:<hash>. Same hash on PostToolUse entries closes the loop.
// ============================================================================

test('recordCompassFire: writes a chronicle entry tagged compass-fire + classification + action_hash', () => {
  const sid = 'cf-tags-' + Date.now();
  const action = 'Bash: rm -rf /tmp/foo/*';
  ch.recordCompassFire({
    session_id: sid,
    action_summary: action,
    classification: 'WITNESS',
    rule_matched: 'rm-rf-wildcard',
    reason: 'wildcard rm under /tmp'
  });
  // compass-fire is a META domain as of v0.2 — excluded from default recall, so
  // query it with include_meta:true (same contract as session-action).
  const hits = ch.recall({ query: 'rm-rf-wildcard', topK: 10, include_meta: true });
  const hit = hits.find(h => h.tags && h.tags.includes('compass-fire'));
  assert.ok(hit, 'should find compass-fire entry via recall (include_meta)');
  assert.ok(hit.tags.includes('classification:WITNESS'), 'tags must include classification');
  assert.ok(hit.tags.includes('rule:rm-rf-wildcard'), 'tags must include rule:<id> when rule matched');
  assert.ok(hit.tags.some(t => t.startsWith('action:')), 'tags must include action:<hash>');
  assert.strictEqual(hit.domain, 'compass-fire');
  assert.strictEqual(hit.layer, 'reflection');
  assert.strictEqual(hit.intensity, 0.7);
});

test('recordCompassFire: action_hash is stable — same summary → same tag → recallable by tag', () => {
  const sid = 'cf-link-' + Date.now();
  const action = 'Bash: git push --force origin main-' + Date.now();
  const hash = ch.actionHash(action);

  ch.recordCompassFire({
    session_id: sid, action_summary: action, classification: 'WITNESS',
    rule_matched: 'force-push', reason: 'force push to main'
  });
  // Simulate the matching PostToolUse entry tagged with the same action hash.
  ch.record({
    session_id: sid,
    content: `[PostToolUse] ${action}\nResult: ok`,
    domain: 'session-action',
    tags: ['post-tool-use', 'bash', 'outcome:success', `action:${hash}`],
    intensity: 0.2
  });

  // Recall by the shared tag should return BOTH endpoints — the chain.
  const chain = ch.recall({ query: 'git push force', topK: 20, tag: `action:${hash}`, include_meta: true });
  assert.ok(chain.length >= 2, `should find both compass-fire + PostToolUse, got ${chain.length}`);
  assert.ok(chain.some(h => h.tags && h.tags.includes('compass-fire')), 'chain must include the compass-fire entry');
  assert.ok(chain.some(h => h.tags && h.tags.includes('post-tool-use')), 'chain must include the PostToolUse entry');
});

test('recordCompassFire: PAUSE classification round-trips', () => {
  const sid = 'cf-pause-' + Date.now();
  const action = 'Bash: echo "-----BEGIN OPENSSH PRIVATE KEY-----" > k-' + Date.now();
  ch.recordCompassFire({
    session_id: sid, action_summary: action, classification: 'PAUSE',
    rule_matched: 'credential-paste', reason: 'private key in command'
  });
  // The PEM block is redacted on write (v0.2), so it is NOT searchable by the
  // secret text — query surviving content (the reason). include_meta because
  // compass-fire is now a META domain.
  const hits = ch.recall({ query: 'private key command', topK: 10, include_meta: true });
  const hit = hits.find(h => h.tags && h.tags.includes('classification:PAUSE'));
  assert.ok(hit, 'should find the PAUSE compass-fire');
  // And the secret itself must not be in the stored content.
  assert.ok(!/BEGIN OPENSSH PRIVATE KEY/.test(hit.content), 'PEM block must be redacted out of the stored entry');
  assert.ok(/\[REDACTED:private-key:/.test(hit.content), 'redaction fingerprint should be present');
});

test('recordCompassFire: missing rule_matched still writes (rule tag is conditional)', () => {
  const sid = 'cf-norule-' + Date.now();
  ch.recordCompassFire({
    session_id: sid,
    action_summary: 'Bash: weird thing-' + Date.now(),
    classification: 'PAUSE',
    rule_matched: null,
    reason: 'memory-escalated, no upstream rule'
  });
  const hits = ch.recall({ query: 'memory-escalated weird thing', topK: 10, include_meta: true });
  const hit = hits.find(h => h.tags && h.tags.includes('compass-fire'));
  assert.ok(hit, 'should still find the entry');
  assert.ok(!hit.tags.some(t => t.startsWith('rule:')), 'no rule tag when rule_matched is null');
});

// ============================================================================
// End-to-end helix loop (criterion #4) — proves memory→compass and
// compass→memory work together. Exercises the full chain in lib space:
//   1. Seed past failures (criterion #1's substrate)
//   2. classify() returns OPEN for a similar new action
//   3. recall+coupling escalates to PAUSE (criterion #2)
//   4. recordCompassFire writes the event with action:<hash> (criterion #3)
//   5. Subsequent PostToolUse-equivalent record() with outcome:success and
//      the SAME action:<hash> closes the chain
//   6. Recall by the action:<hash> tag returns both endpoints
// ============================================================================

test('e2e helix loop: past failures → escalation → compass-fire → outcome → chain recall', () => {
  const sid = 'e2e-helix-' + Date.now();
  const marker = 'e2e-' + Date.now();
  // The action we'll be evaluating — uses a unique marker so seeded similar
  // entries actually match via FTS without colliding with prior test data.
  const action_summary = `Bash: deploy-script ${marker} --target=prod`;

  // STEP 1: seed three past outcome:failure entries that FTS will match.
  // Match keyword: "deploy-script <marker>" — uniquely tied to this test.
  for (let i = 0; i < 3; i++) {
    ch.record({
      session_id: sid,
      content: `[PostToolUse] Bash: deploy-script ${marker} run ${i}\nResult: Traceback at line 42`,
      domain: 'session-action',
      tags: ['post-tool-use', 'bash', 'outcome:failure'],
      intensity: 0.2
    });
  }
  // One past success for ratio variety (3F/4T = 0.75, above threshold).
  ch.record({
    session_id: sid,
    content: `[PostToolUse] Bash: deploy-script ${marker} run-pass\nResult: ok`,
    domain: 'session-action',
    tags: ['post-tool-use', 'bash', 'outcome:success'],
    intensity: 0.2
  });

  // STEP 2: simulate classify() on this action — should be OPEN (no rule).
  // We assert this directly via the library so the test is closed-loop.
  const baseResult = compass.classify({
    tool_name: 'Bash',
    tool_input: { command: `deploy-script ${marker} --target=prod` }
  }, { has_goal: false });
  assert.strictEqual(baseResult.classification, 'OPEN', 'base classification must be OPEN for this action');

  // STEP 3: recall similar entries, then run the coupling policy.
  // Query by the unique marker so this end-to-end test deterministically sees
  // only its own seeded entries (3F/1S) regardless of other tests' chronicle
  // writes in the shared DB. (Before the FTS-sanitizer fix this query threw and
  // rode the recency fallback, which happened to mask shared-DB interference;
  // the realistic action_summary→FTS retrieval path is now covered by the
  // dedicated 'ranks by FTS similarity' test above.)
  const similar = ch.recall({ query: marker, topK: 10, include_meta: true });
  const coupled = escalateByMemory(baseResult, similar);
  assert.strictEqual(coupled.classification, 'PAUSE', 'memory should escalate OPEN→PAUSE given 3/4 past failures');
  assert.strictEqual(coupled.memory_escalated, true);
  assert.strictEqual(coupled.rule_id, 'memory:similar-failures');

  // STEP 4: record the compass-fire entry with action_hash tag.
  ch.recordCompassFire({
    session_id: sid,
    action_summary,
    classification: coupled.classification,
    rule_matched: coupled.rule_id,
    reason: coupled.reason
  });

  // STEP 5: simulate PostToolUse for the same action after user override.
  // PostToolUse writes its own action:<hash> tag from action_summary.
  const hash = ch.actionHash(action_summary);
  ch.record({
    session_id: sid,
    content: `[PostToolUse] ${action_summary}\nResult: deploy completed successfully`,
    domain: 'session-action',
    tags: ['post-tool-use', 'bash', 'outcome:success', `action:${hash}`],
    intensity: 0.2
  });

  // STEP 6: recall by the shared action:<hash> tag — must return both
  // endpoints. This is the chain made explicit.
  const chain = ch.recall({ query: marker, topK: 20, tag: `action:${hash}`, include_meta: true });
  assert.ok(chain.length >= 2, `chain must include both compass-fire + PostToolUse, got ${chain.length}`);
  assert.ok(chain.some(h => h.tags && h.tags.includes('compass-fire')), 'chain must include compass-fire');
  assert.ok(chain.some(h => h.tags && h.tags.includes('outcome:success')), 'chain must include outcome:success from post-override PostToolUse');
});

// ============================================================================
// v0.2: secret redaction (lib/secrets.js) + write-path + recall-surface hygiene
// ============================================================================

const secrets = require('../lib/secrets');

// A 64-hex token shaped like the Sovereign Bridge bearer (NOT a real secret).
const FAKE_BEARER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

test('redact: bearer token is fingerprinted, scheme preserved', () => {
  const out = secrets.redactSecrets(`curl -H "Authorization: Bearer ${FAKE_BEARER}" https://x`);
  assert.ok(!out.includes(FAKE_BEARER), 'raw token must be gone');
  assert.ok(/Authorization: Bearer \[REDACTED:bearer:[0-9a-f]{8}\]/.test(out), 'scheme kept, value fingerprinted');
});

test('redact: sk-/ghp_/AKIA prefixed tokens are redacted', () => {
  assert.ok(/\[REDACTED:sk-key:/.test(secrets.redactSecrets('sk-' + 'A'.repeat(40))), 'sk- key');
  assert.ok(/\[REDACTED:github-token:/.test(secrets.redactSecrets('ghp_' + 'b'.repeat(36))), 'github token');
  assert.ok(/\[REDACTED:aws-akid:/.test(secrets.redactSecrets('AKIA' + 'ABCDEFGH12345678')), 'aws akid');
});

test('redact: PEM private key block is redacted', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123def456\n-----END OPENSSH PRIVATE KEY-----';
  const out = secrets.redactSecrets(`echo "${pem}"`);
  assert.ok(!/BEGIN OPENSSH PRIVATE KEY/.test(out), 'PEM header gone');
  assert.ok(/\[REDACTED:private-key:/.test(out), 'fingerprinted');
});

test('redact: password/token assignment masks value, keeps label', () => {
  const out = secrets.redactSecrets('export DB_PASSWORD=sup3rSecretValue12345');
  assert.ok(!out.includes('sup3rSecretValue12345'), 'value gone');
  assert.ok(/PASSWORD=\[REDACTED:secret-assign:/.test(out), 'label kept, value fingerprinted');
});

test('redact: does NOT over-redact a bare 40-char git SHA', () => {
  const sha = 'a'.repeat(40);
  const prose = `the fix landed in commit ${sha} on main`;
  assert.strictEqual(secrets.redactSecrets(prose), prose, 'a bare SHA in prose must be untouched');
});

test('redact: normal content passes through unchanged; null is null', () => {
  assert.strictEqual(secrets.redactSecrets('just a normal insight about attention'), 'just a normal insight about attention');
  assert.strictEqual(secrets.redactSecrets(null), null);
});

test('redact: same secret → same fingerprint (linkable)', () => {
  const a = secrets.redactSecrets(`Bearer ${FAKE_BEARER}`);
  const b = secrets.redactSecrets(`token: ${FAKE_BEARER}`);
  const fpA = a.match(/:([0-9a-f]{8})\]/)[1];
  const fpB = b.match(/:([0-9a-f]{8})\]/)[1];
  assert.strictEqual(fpA, fpB, 'fingerprint identifies the value across rows');
});

test('compass: shared detection still classifies credentials as PAUSE', () => {
  const C = cmd => compass.classify({ tool_name: 'Bash', tool_input: { command: cmd } });
  assert.strictEqual(C(`curl -H "Authorization: Bearer ${FAKE_BEARER}" x`).classification, 'PAUSE', 'bearer header');
  assert.strictEqual(C('echo sk-' + 'A'.repeat(40)).classification, 'PAUSE', 'sk- key');
  assert.strictEqual(C('git remote set-url o https://ghp_' + 'b'.repeat(36) + '@github.com/x').classification, 'PAUSE', 'github token');
  assert.strictEqual(C('export AWS_SECRET_ACCESS_KEY=AKIAEXAMPLE').classification, 'PAUSE', 'aws_secret name (coarse detect)');
  assert.strictEqual(C('credential-paste rule id is not itself a secret').classification, 'OPEN', 'no false PAUSE on the word credential');
  assert.strictEqual(C('git log --oneline -5').classification, 'OPEN', 'plain command stays OPEN');
});

test('write-path: record() redacts a credential embedded in content', () => {
  const sid = 'redact-write-' + Date.now();
  const r = ch.record({ session_id: sid, content: `ran: curl -H "Authorization: Bearer ${FAKE_BEARER}"`, domain: 'misc' });
  assert.ok(r.id, 'record returns an id');
  const hits = ch.recall({ query: 'ran curl Authorization', topK: 5, include_meta: true });
  const hit = hits.find(h => h.id === r.id);
  assert.ok(hit, 'should recall the row');
  assert.ok(!hit.content.includes(FAKE_BEARER), 'stored content must not contain the raw token');
  assert.ok(/\[REDACTED:bearer:/.test(hit.content), 'stored content carries the fingerprint');
});

test('write-path: logCompass() redacts action_summary and reason', () => {
  const sid = 'redact-compass-' + Date.now();
  ch.logCompass({
    session_id: sid, tool_name: 'Bash',
    action_summary: `Bash: curl -H "Authorization: Bearer ${FAKE_BEARER}"`,
    classification: 'PAUSE', rule_matched: 'credential-paste',
    // Bare hex with no credential label is deliberately NOT redacted (same reason
    // git SHAs aren't), so label it to prove the reason column is also scrubbed.
    reason: `session token: ${FAKE_BEARER}`
  });
  const row = ch.getCompassHistory({ limit: 50 }).find(e => e.session_id === sid);
  assert.ok(row, 'compass_log row present');
  assert.ok(!row.action_summary.includes(FAKE_BEARER), 'action_summary redacted');
  assert.ok(!row.reason.includes(FAKE_BEARER), 'reason redacted');
});

test('surface: compass-fire is excluded from default recall, present with include_meta', () => {
  const sid = 'cf-meta-' + Date.now();
  const marker = 'uniquemarker' + Date.now();
  ch.recordCompassFire({
    session_id: sid, action_summary: `Bash: ${marker} thing`,
    classification: 'PAUSE', rule_matched: 'credential-paste', reason: 'x'
  });
  const def = ch.recall({ query: marker, topK: 10 });
  assert.ok(!def.some(h => h.tags && h.tags.includes('compass-fire')), 'default recall must NOT surface compass-fire');
  const meta = ch.recall({ query: marker, topK: 10, include_meta: true });
  assert.ok(meta.some(h => h.tags && h.tags.includes('compass-fire')), 'include_meta surfaces compass-fire');
});

test('surface: getState.recent_insights excludes compass-fire', () => {
  const sid = 'cf-getstate-' + Date.now();
  ch.recordCompassFire({
    session_id: sid, action_summary: 'Bash: getstate-cf-probe',
    classification: 'PAUSE', rule_matched: 'credential-paste', reason: 'x'
  });
  const s = ch.getState(sid);
  assert.ok(!s.recent_insights.some(i => i.domain === 'compass-fire'), 'getState must not include compass-fire rows');
});

test('fail-safe: redact-or-drop — record() drops rather than persist raw on redaction throw', () => {
  const sid = 'failsafe-' + Date.now();
  const marker = 'failsafemarker' + Date.now();
  const orig = secrets.scrub;
  secrets.scrub = () => { throw new Error('boom'); };
  try {
    const r = ch.record({ session_id: sid, content: `secret-bearing ${marker}`, domain: 'misc' });
    assert.strictEqual(r.id, null, 'record must return null id when dropped');
    assert.strictEqual(r.dropped, true, 'record must flag dropped');
  } finally {
    secrets.scrub = orig;
  }
  // The dropped row must not be in the db (search with the real redactor restored).
  const hits = ch.recall({ query: marker, topK: 10, include_meta: true });
  assert.ok(!hits.some(h => h.content.includes(marker)), 'dropped content must never be persisted');
});

test('retention: prune() bounds compass_log (old+overflow) and pending_confirmations', () => {
  const sid = 'prune-' + Date.now();
  const now = Date.now();
  const day = 86400000;
  const insertLog = ch.db().prepare(`INSERT INTO compass_log (session_id, tool_name, action_summary, classification, occurred_at) VALUES (?, 'Bash', ?, 'OPEN', ?)`);
  insertLog.run(sid, 'old-1', now - 40 * day);
  insertLog.run(sid, 'old-2', now - 41 * day);
  insertLog.run(sid, 'old-3', now - 42 * day);
  insertLog.run(sid, 'recent-1', now - 1 * day);
  insertLog.run(sid, 'recent-2', now - 2 * day);

  // Seed pending_confirmations: one used, one expired, one live.
  ch.createPendingConfirmation({ session_id: sid, action_summary: 'live one', ttl_ms: 10 * 60000 });
  const used = ch.createPendingConfirmation({ session_id: sid, action_summary: 'used one' });
  ch.approveConfirmation({ token: used.token });
  ch.consumeApproval(ch.findApproval({ session_id: sid, action_summary: 'used one' }).id);
  const expired = ch.createPendingConfirmation({ session_id: sid, action_summary: 'expired one', ttl_ms: -1000 });

  const before = ch.getCompassHistory({ limit: 100 }).filter(e => e.session_id === sid).length;
  assert.strictEqual(before, 5, 'seeded 5 compass_log rows');

  const res = ch.prune({ now, retainDays: 30, retainRows: 2 });
  assert.strictEqual(res.compass_log_deleted, 3, 'the 3 old+overflow rows deleted');
  const after = ch.getCompassHistory({ limit: 100 }).filter(e => e.session_id === sid);
  assert.strictEqual(after.length, 2, 'the 2 recent rows kept');
  assert.ok(after.every(e => /recent/.test(e.action_summary)), 'only recent rows survive');

  const pend = ch.listPendingConfirmations({ session_id: sid, limit: 50 });
  assert.ok(!pend.some(p => p.action_summary === 'used one'), 'used pending pruned');
  assert.ok(pend.some(p => p.action_summary === 'live one'), 'live pending kept');
});

// ============================================================================
// v0.2 security-review hardening: close the detector⊃redactor gap, add token
// formats, fix the tokenizer false-positive, cover pending_confirmations.
// ============================================================================

const R = secrets.redactSecrets;

test('redact: JSON-embedded secret ("token":"...") is masked (the critical miss)', () => {
  const v = 'aBcD1234EfGh5678IjKl9012MnOp';
  const out = R(`{"url":"https://x","token":"${v}"}`);
  assert.ok(!out.includes(v), 'JSON token value must be masked');
  assert.ok(/\[REDACTED:secret-assign:/.test(out), 'fingerprinted');
  assert.ok(secrets.looksLikeSecret(`{"password":"${v}"}`), 'JSON secret is also detected (PAUSE)');
});

test('redact: URL basic-auth password (scheme://user:pass@host) is masked', () => {
  const out = R('git clone https://alice:s3cr3tPassw0rd123@github.com/org/repo.git');
  assert.ok(!out.includes('s3cr3tPassw0rd123'), 'url password masked');
  assert.ok(/\[REDACTED:url-auth:/.test(out));
  assert.ok(!R('postgres://admin:supersecretpassword123@db:5432/x').includes('supersecretpassword123'), 'db url masked');
});

test('redact: credential value with special chars (@!#$) is masked', () => {
  const out = R('password=P@ssw0rd!Sup3r#SecretValue');
  assert.ok(!out.includes('P@ssw0rd!Sup3r#SecretValue'), 'special-char value masked');
  assert.ok(secrets.looksLikeSecret('password=P@ssw0rd!Sup3r#SecretValue'));
});

test('redact: cloud/SaaS token formats (Slack/Stripe/Google/npm/SendGrid)', () => {
  // Tokens are assembled from fragments so the prefix is never contiguous in
  // source — GitHub push-protection flags real-looking key literals, and these
  // are fakes. The runtime value still matches the redactor patterns.
  const cases = {
    'slack-token': 'xox' + 'b-2488392019-2489531829-aBcDeFgHiJkLmNoPqRsTuVwX',
    'stripe-key': 'sk_' + 'live_51H8aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
    'google-key': 'AIz' + 'aSyD1234567890abcdefghijklmnopqrstuvwx',
    'npm-token': 'npm' + '_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'sendgrid-key': 'SG' + '.aBcDeFgHiJkLmNoPqRs.tUvWxYz0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ'
  };
  for (const [kind, tok] of Object.entries(cases)) {
    const out = R(`export KEY=${tok}`);
    assert.ok(!out.includes(tok), `${kind} must be masked (got: ${out})`);
    assert.ok(secrets.looksLikeSecret(tok), `${kind} must be detected`);
  }
});

test('redact: short bearer token (8-15 chars) in Authorization header is masked', () => {
  const out = R('curl -H "Authorization: Bearer abc123def456" https://api.x');
  assert.ok(!/Bearer abc123def456/.test(out), 'short bearer must be masked, not just detected');
  assert.ok(secrets.looksLikeSecret('Authorization: Bearer abc123def456'));
});

test('redact: bearer fragment truncated at the … boundary is masked', () => {
  const out = R('Bash: ' + 'x'.repeat(180) + 'Bearer AbCdEfGhIj…');
  assert.ok(!/Bearer AbCdEfGhIj…/.test(out), 'truncated bearer prefix must be masked');
});

test('redact: tokenizer/tokens are NOT over-redacted (false-positive fix)', () => {
  const prose = 'Switched tokenizer = tiktoken_cl100k_base for the GPT-4 comparison runs';
  assert.strictEqual(R(prose), prose, 'tokenizer assignment must pass through untouched');
  assert.strictEqual(R('tokens = the_quick_brown_fox_jumped_over_lazy'), 'tokens = the_quick_brown_fox_jumped_over_lazy');
  assert.ok(!secrets.looksLikeSecret(prose), 'tokenizer prose is not classified a secret');
});

test('scrub: fixed-point backstop — output never holds a maskable secret', () => {
  const v = 'aBcD1234EfGh5678IjKl';
  const out = secrets.scrub(`token: ${v}`);
  assert.strictEqual(secrets.redactSecrets(out), out, 'scrub output is a redactor fixed point');
  assert.ok(!out.includes(v));
});

test('detection == redaction coverage: anything detected is also maskable', () => {
  const samples = [
    'Authorization: Bearer abc123def456', '{"token":"aBcD1234EfGh5678"}',
    'https://u:p4ssword12345@h/x', 'export KEY=sk_live_51H8aBcDeFgHiJkLmNoPq',
    'password=P@ss!w0rd#longvalue'
  ];
  for (const s of samples) {
    if (secrets.looksLikeSecret(s)) {
      assert.notStrictEqual(secrets.redactSecrets(s), s, `detected but not maskable: ${s}`);
    }
  }
});

test('write-path: createPendingConfirmation redacts stored summary + reason, keeps hash', () => {
  const sid = 'pending-redact-' + Date.now();
  const tok = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6';
  const summary = `Bash: curl -H "Authorization: Bearer ${tok}"`;
  const p = ch.createPendingConfirmation({ session_id: sid, action_summary: summary, rule_matched: 'credential-paste', reason: `token: ${tok}` });
  // The hash must be over the RAW summary so the retry-side findApproval matches.
  assert.strictEqual(p.action_hash, ch.actionHash(summary), 'hash is over the raw summary');
  const row = ch.listPendingConfirmations({ session_id: sid })[0];
  assert.ok(!row.action_summary.includes(tok), 'stored summary must be scrubbed');
  assert.ok(!String(row.reason).includes(tok), 'stored reason must be scrubbed');
});

test('compass: pattern_source resolves to a RegExp (fail-loud guard exists)', () => {
  // credential-paste classifies PAUSE → proves DETECTION_REGEX resolved, not a
  // silent OPEN downgrade.
  const r = compass.classify({ tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer abc123def4567890"' } });
  assert.strictEqual(r.classification, 'PAUSE');
  assert.strictEqual(r.rule_id, 'credential-paste');
});

// ============================================================================
// v0.3 Stage 2: method store (recordMethod) — domain:'method', surfaced only via
// targeted lookup, excluded from the generic firehose.
// ============================================================================

test('recordMethod: formats numbered steps, tags shape+source+tool, excluded from default recall', () => {
  const sid = 'method-' + Date.now();
  const shape = 'rotate-token-' + Date.now();
  const r = ch.recordMethod({ session_id: sid, shape, steps: ['read -s prompt', 'write env + plist', 'launchctl reload'], acceptance: 'heartbeat 200', tool_classes: ['Bash'] });
  assert.ok(r.id, 'returns id');
  const m = ch.recall({ query: shape, topK: 5, include_meta: true, tag: 'method' }).find(h => h.tags && h.tags.includes(`shape:${shape}`));
  assert.ok(m, 'recallable via include_meta + tag');
  assert.strictEqual(m.domain, 'method');
  assert.strictEqual(m.layer, 'ground_truth');
  assert.strictEqual(m.intensity, 0.8);
  assert.ok(/^\[method\] /.test(m.content), 'has [method] header');
  assert.ok(/1\. read -s prompt/.test(m.content) && /3\. launchctl reload/.test(m.content), 'numbered steps');
  assert.ok(/Acceptance: heartbeat 200/.test(m.content), 'acceptance line');
  assert.ok(m.tags.includes('source:explicit') && m.tags.includes('tool:bash'), 'source + tool tags');
  // The cardinal-rule guarantee: methods never enter the generic firehose.
  assert.ok(!ch.recall({ query: shape, topK: 10 }).some(h => h.tags && h.tags.includes('method')), 'excluded from default recall');
  assert.ok(!ch.getState(sid).recent_insights.some(i => i.domain === 'method'), 'excluded from getState surface');
});

test('recordMethod: rejects empty shape / no steps; auto-distill ranks lower', () => {
  assert.throws(() => ch.recordMethod({ session_id: 's', shape: '   ', steps: ['x'] }), /shape/);
  assert.throws(() => ch.recordMethod({ session_id: 's', shape: 'x', steps: [] }), /step/);
  const shape = 'auto-shape-' + Date.now();
  const r = ch.recordMethod({ session_id: 's-auto', shape, steps: ['a step'], source: 'auto-distill' });
  const m = ch.recall({ query: shape, topK: 5, include_meta: true, tag: 'method' }).find(h => h.id === r.id);
  assert.strictEqual(m.layer, 'hypothesis', 'auto-distill is lower-confidence');
  assert.ok(m.tags.includes('source:auto-distill'));
});

// ============================================================================
// v0.3 Stage 2 step 2: recall-surface selection (lib/surface) — the cardinal rule
// ============================================================================
const surface = require('../lib/surface');

test('surface.isTrivialPrompt: acks + short-no-token trivial; task prompts not', () => {
  for (const p of ['yea', 'nice thats fine', 'ok', 'try hq again', 'merge it', 'keep going'])
    assert.ok(surface.isTrivialPrompt(p), `"${p}" should be trivial`);
  for (const p of ['fix the parser bug in lib/secrets.js', 'how do I rotate the bridge token', 'review the credential diff'])
    assert.ok(!surface.isTrivialPrompt(p), `"${p}" should NOT be trivial`);
});

test('surface.selectInjection: trivial prompt suppresses generic recall', () => {
  const generic = [{ id: 1, content: 'unrelated chatter', tags: [], domain: 'x' }];
  const r = surface.selectInjection({ goal: null, prompt: 'yea', recall: () => generic });
  assert.strictEqual(r.trivial, true);
  assert.strictEqual(r.hits.length, 0, 'no generic insights on a trivial prompt');
});

test('surface.selectInjection: active goal trims generic recall to topK 2 + relevance-filters', () => {
  let askedTopK = null;
  const recall = (opts) => {
    if (opts.tag === 'method') return [];
    askedTopK = opts.topK;
    return [
      { id: 1, content: 'parser tokenization edge cases', tags: [], domain: 'x' },
      { id: 2, content: 'totally unrelated pizza note', tags: [], domain: 'x' }
    ].slice(0, opts.topK);
  };
  const r = surface.selectInjection({ goal: { goal: 'fix the parser tokenization' }, prompt: 'parser tokenization bug', recall });
  assert.strictEqual(askedTopK, 2, 'goal active -> topK 2 (trim harder)');
  assert.ok(r.hits.length >= 1 && r.hits.every(h => /parser|token/.test(h.content)), 'relevance-filtered to shared tokens');
});

test('surface.selectInjection: method surfaces only above the relevance bar', () => {
  const method = { id: 9, content: '[method] rotate-bridge-token\n1. read -s\n2. write env', domain: 'method', tags: ['method', 'shape:rotate-bridge-token', 'source:explicit'], layer: 'ground_truth' };
  const recall = (opts) => (opts.tag === 'method' ? [method] : []);
  const hit = surface.selectInjection({ goal: { goal: 'rotate the bridge token on HQ' }, prompt: 'do it', recall });
  assert.ok(hit.method && hit.method.id === 9, 'relevant method surfaced (slug shares tokens)');
  const miss = surface.selectInjection({ goal: { goal: 'design the dashboard layout' }, prompt: 'do it', recall });
  assert.strictEqual(miss.method, null, 'irrelevant method NOT surfaced (weak match = no method)');
});

test('surface.selectInjection: caps generic hits at 3 and is fail-open', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: i, content: `shared token chronicle entry number ${i}`, tags: [], domain: 'x' }));
  const r = surface.selectInjection({ goal: null, prompt: 'chronicle entry token', recall: (o) => (o.tag === 'method' ? [] : many.slice(0, o.topK)) });
  assert.ok(r.hits.length <= 3, 'never more than 3 insights');
  const safe = surface.selectInjection({ goal: null, prompt: 'something real here', recall: () => { throw new Error('boom'); } });
  assert.deepStrictEqual({ m: safe.method, h: safe.hits.length }, { m: null, h: 0 }, 'recall throw is fail-open');
});

test('surface.buildContext: method leads the insights section; goal shown', () => {
  const ctx = surface.buildContext({
    goal: { goal: 'G' },
    method: { content: '[method] x\n1. step', tags: [] },
    hits: [{ id: 1, content: 'h1', domain: 'd', layer: 'hypothesis' }]
  });
  assert.ok(ctx.indexOf('**Method for this kind of task:**') < ctx.indexOf('**Related from chronicle:**'), 'method leads insights');
  assert.ok(/Current goal:/.test(ctx));
});

ch.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
