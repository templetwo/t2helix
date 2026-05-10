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

test('compass: edit without goal → PAUSE', () => {
  const r = compass.classify(
    { tool_name: 'Edit', tool_input: { file_path: '/tmp/x.js' } },
    { has_goal: false }
  );
  assert.strictEqual(r.classification, 'PAUSE');
  assert.strictEqual(r.rule_id, 'edit-no-context');
});

test('compass: edit with goal → OPEN', () => {
  const r = compass.classify(
    { tool_name: 'Edit', tool_input: { file_path: '/tmp/x.js' } },
    { has_goal: true }
  );
  assert.strictEqual(r.classification, 'OPEN');
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

ch.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
