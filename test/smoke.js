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
  const hits = ch.recall({ query: 'rm-rf-wildcard', topK: 10 });
  const hit = hits.find(h => h.tags && h.tags.includes('compass-fire'));
  assert.ok(hit, 'should find compass-fire entry via recall');
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
  const hits = ch.recall({ query: 'OPENSSH credential', topK: 10 });
  const hit = hits.find(h => h.tags && h.tags.includes('classification:PAUSE'));
  assert.ok(hit, 'should find the PAUSE compass-fire');
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
  const hits = ch.recall({ query: 'memory-escalated weird thing', topK: 10 });
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

ch.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
