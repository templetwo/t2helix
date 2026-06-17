'use strict';

// Acceptance matrix for the v0.10.0 error-atlas loader (lib/atlas.js + the CLI).
// Complements test/import-atlas.js (which covers the happy path + recall hygiene
// + the CLI exit-code contract) by pinning the EDGE-CASE policy explicitly, case
// by case, so a future change to the loader that silently alters any of these
// behaviors trips a named test.
//
// Each numbered block maps 1:1 to the mission's acceptance cases. Where the loader
// already had a clear policy, the test documents/locks it. Where it did not, the
// test encodes the smallest defensible policy:
//   • conflicting-resolution duplicates  → BOTH load (append-only) + surfaced via
//     importAtlas().conflicts (not silently buried).
//   • a record() throw on one entry (e.g. >100KB content)  → that entry is DROPPED
//     (counted, fingerprint only), the rest of the batch still loads — never an
//     all-or-nothing abort that strands the valid entries after it.
//
// Same harness shape as smoke.js / import-atlas.js: an isolated temp data dir, a
// shared chronicle connection, node:assert, exit non-zero on any failure. Patterns
// are unique per case because the DB persists across cases within this one run.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-atlas-accept-'));
process.env.T2HELIX_DATA_DIR = tmpDir;

const ch = require('../lib/chronicle');
const atlas = require('../lib/atlas');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'import-atlas.js');
function runCli(args, { inheritDataDir = false } = {}) {
  const env = { ...process.env };
  if (!inheritDataDir) { delete env.T2HELIX_DATA_DIR; delete env.CLAUDE_PLUGIN_DATA; }
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
// How many error-fix rows match a content substring (unique per case → exact count).
function rows(like) {
  return ch.db().prepare(`SELECT count(*) AS n FROM insights WHERE domain='error-fix' AND content LIKE ?`).get(like).n;
}

console.log(`T2Helix error-atlas acceptance matrix (data: ${tmpDir})`);

// ── 1. Valid minimal entry → loads ────────────────────────────────────────────
test('1 valid minimal entry: parses clean and loads exactly one row', () => {
  const { records, errors } = atlas.parseAtlas(JSON.stringify({ pattern: 'Acc1: minimal', resolution: 'do the minimal fix' }));
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(records.length, 1);
  const r = atlas.importAtlas({ ch, records });
  assert.strictEqual(r.counts.inserted, 1);
  assert.strictEqual(rows('%Acc1: minimal%'), 1);
});

// ── 2. Valid DENSE entry with extra fields → loads, extras IGNORED ─────────────
test('2 dense entry (tags/language/ecosystem): loads, extra fields are ignored not errored', () => {
  const dense = { pattern: 'Acc2: dense', resolution: 'fix it densely', tags: ['py', 'pip'], language: 'python', ecosystem: 'pip', severity: 'high' };
  const { records, errors } = atlas.parseAtlas(JSON.stringify(dense));
  assert.strictEqual(errors.length, 0, 'extra fields must not be a parse error');
  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(Object.keys(records[0]).sort(), ['pattern', 'resolution'], 'only pattern+resolution are read');
  const ins = atlas.buildInsight(records[0]);
  assert.ok(!ins.tags.includes('py') && !ins.tags.includes('python'), 'entry tags/fields do NOT leak into insight tags');
  assert.ok(!/severity|ecosystem|language/.test(ins.content), 'extra fields do not appear in stored content');
  const r = atlas.importAtlas({ ch, records });
  assert.strictEqual(r.counts.inserted, 1);
});

// ── 3. Duplicate, SAME resolution → skipped (idempotent), no conflict ──────────
test('3 duplicate same-resolution: second is skipped, not a conflict', () => {
  const dup = JSON.stringify({ pattern: 'Acc3: same', resolution: 'identical fix' });
  const { records } = atlas.parseAtlas(dup + '\n' + dup);
  const r = atlas.importAtlas({ ch, records });
  assert.strictEqual(r.counts.inserted, 1, 'one inserted');
  assert.strictEqual(r.counts.skipped, 1, 'the identical second line is skipped');
  assert.strictEqual(r.conflicts.length, 0, 'identical resolution is NOT a conflict');
  assert.strictEqual(rows('%Acc3: same%'), 1);
});

// ── 4. Duplicate, CONFLICTING resolution → BOTH load AND surfaced ──────────────
test('4 duplicate conflicting-resolution: both load AND the conflict is surfaced', () => {
  const a = JSON.stringify({ pattern: 'Acc4: conflict', resolution: 'fix it the first way' });
  const b = JSON.stringify({ pattern: 'Acc4: conflict', resolution: 'fix it the SECOND, different way' });
  const { records } = atlas.parseAtlas(a + '\n' + b);
  const r = atlas.importAtlas({ ch, records });
  assert.strictEqual(r.counts.inserted, 2, 'both divergent fixes load (append-only — an error can have >1 valid fix)');
  assert.strictEqual(r.conflicts.length, 1, 'exactly one conflicting pattern surfaced');
  assert.strictEqual(r.conflicts[0].pattern, 'Acc4: conflict');
  assert.strictEqual(r.conflicts[0].count, 2, 'two distinct resolutions for the pattern');
  assert.strictEqual(r.conflicts[0].fps.length, 2);
  assert.ok(!('resolution' in r.conflicts[0]) && !('resolutions' in r.conflicts[0]),
    'conflict report must NOT carry the (possibly secret-bearing) resolution text');
  assert.strictEqual(rows('%Acc4: conflict%'), 2, 'both rows persisted');
});

test('4b detectConflicts is pure and finds nothing when resolutions agree', () => {
  const recs = [{ pattern: 'p', resolution: 'r' }, { pattern: 'p', resolution: 'r' }, { pattern: 'q', resolution: 'r2' }];
  assert.strictEqual(atlas.detectConflicts(recs).length, 0);
});

// ── 5/6. Missing pattern / missing resolution → rejected with a line number ────
test('5 missing pattern (no key): rejected, not loaded', () => {
  const { records, errors } = atlas.parseAtlas(JSON.stringify({ resolution: 'orphan resolution AccM5' }));
  assert.strictEqual(records.length, 0);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].line, 1);
  assert.match(errors[0].reason, /pattern/);
  assert.strictEqual(rows('%AccM5%'), 0);
});

test('6 missing resolution (no key): rejected, not loaded', () => {
  const { records, errors } = atlas.parseAtlas(JSON.stringify({ pattern: 'AccM6: lonely pattern' }));
  assert.strictEqual(records.length, 0);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].reason, /resolution/);
  assert.strictEqual(rows('%AccM6%'), 0);
});

// ── 7/8. Non-string pattern / resolution → rejected (typeof guard) ─────────────
test('7 non-string pattern (number, null, array): each rejected', () => {
  for (const bad of [42, null, ['a'], { nested: 1 }, true]) {
    const { records, errors } = atlas.parseAtlas(JSON.stringify({ pattern: bad, resolution: 'x' }));
    assert.strictEqual(records.length, 0, `pattern=${JSON.stringify(bad)} must not produce a record`);
    assert.strictEqual(errors.length, 1, `pattern=${JSON.stringify(bad)} must be one error`);
    assert.match(errors[0].reason, /pattern/);
  }
});

test('8 non-string resolution (number, null, array): each rejected', () => {
  for (const bad of [5, null, [], { x: 1 }, false]) {
    const { records, errors } = atlas.parseAtlas(JSON.stringify({ pattern: 'AccNS8', resolution: bad }));
    assert.strictEqual(records.length, 0, `resolution=${JSON.stringify(bad)} must not produce a record`);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].reason, /resolution/);
  }
  assert.strictEqual(rows('%AccNS8%'), 0);
});

// ── 9. HUGE entry → dropped, NOT a batch abort; recall not poisoned ────────────
test('9 huge entry (>100KB) is dropped per-entry; the valid sibling still loads', () => {
  const huge = 'X'.repeat(150 * 1024);                       // > the 100KB content cap
  const recs = [
    { pattern: 'AccHuge9: oversized', resolution: huge },
    { pattern: 'AccSmall9: fine', resolution: 'a normal small fix' }
  ];
  const r = atlas.importAtlas({ ch, records: recs });
  assert.strictEqual(r.counts.dropped, 1, 'the oversized entry is dropped, not loaded');
  assert.strictEqual(r.counts.inserted, 1, 'the valid sibling AFTER it still loads (no batch abort)');
  assert.strictEqual(r.dropped[0].fp.length, 12, 'drop record carries fingerprint only');
  assert.ok(!('pattern' in r.dropped[0]) && !('content' in r.dropped[0]), 'dropped row must not echo raw content');
  assert.strictEqual(rows('%AccHuge9%'), 0, 'oversized row is NOT persisted (recall not poisoned)');
  assert.strictEqual(rows('%AccSmall9%'), 1, 'the small valid row IS persisted');
});

// ── 10. Malformed JSON → rejected with a line number ───────────────────────────
test('10 malformed JSON line: rejected as invalid JSON', () => {
  const { records, errors } = atlas.parseAtlas('this is not json AccBad10');
  assert.strictEqual(records.length, 0);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].reason, /invalid JSON/);
});

// ── 11. Empty array / empty file → no-op, no crash ─────────────────────────────
test('11 a JSON array/primitive line is "not an object"; empty + all-blank files are clean no-ops', () => {
  const arr = atlas.parseAtlas('[1,2,3]');
  assert.strictEqual(arr.records.length, 0);
  assert.strictEqual(arr.errors.length, 1);
  assert.match(arr.errors[0].reason, /not a JSON object/);

  const prim = atlas.parseAtlas('42');
  assert.strictEqual(prim.records.length, 0);
  assert.strictEqual(prim.errors.length, 1, 'a bare primitive is rejected as not-an-object');

  const empty = atlas.parseAtlas('');
  assert.strictEqual(empty.records.length, 0);
  assert.strictEqual(empty.errors.length, 0, 'empty input is a clean no-op, not an error');

  const blanks = atlas.parseAtlas('\n   \n\t\n');
  assert.strictEqual(blanks.records.length, 0);
  assert.strictEqual(blanks.errors.length, 0, 'all-blank input is a clean no-op');
});

// ── 12. Mixed valid + invalid → valid subset loads, invalid reported ───────────
test('12 mixed valid+invalid: valid subset loads, every invalid line reported', () => {
  const lines = [
    JSON.stringify({ pattern: 'AccMix12a', resolution: 'good one' }),  // valid
    'NOT JSON HERE',                                                    // invalid: bad JSON
    JSON.stringify({ pattern: 'AccMix12b' }),                          // invalid: missing resolution
    JSON.stringify({ pattern: 'AccMix12c', resolution: 'good two' }),   // valid
    JSON.stringify({ pattern: 7, resolution: 'x' })                     // invalid: non-string pattern
  ].join('\n');
  const { records, errors } = atlas.parseAtlas(lines);
  assert.strictEqual(records.length, 2, 'two valid records');
  assert.strictEqual(errors.length, 3, 'three invalid lines, each reported');
  assert.deepStrictEqual(errors.map(e => e.line).sort(), [2, 3, 5], '1-based line numbers point at the bad lines');
  const r = atlas.importAtlas({ ch, records });
  assert.strictEqual(r.counts.inserted, 2);
  assert.strictEqual(rows('%AccMix12a%'), 1);
  assert.strictEqual(rows('%AccMix12c%'), 1);
});

// ── CLI end-to-end: huge-in-batch is a PARTIAL load (exit 1), valid subset lands ─
test('CLI huge-in-batch: exit 1 (partial), oversized dropped, valid sibling loaded', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-atlas-accept-cli-'));
  const f = path.join(d, 'huge.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ pattern: 'CliHuge: oversized', resolution: 'X'.repeat(150 * 1024) }),
    JSON.stringify({ pattern: 'CliSmall: fine', resolution: 'normal fix' })
  ].join('\n') + '\n');
  const r = runCli(['--file', f, '--data-dir', d]);
  assert.strictEqual(r.status, 1, `expected exit 1 on partial (dropped) load, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout, /inserted\s*:\s*1/, 'the valid sibling still loaded');
  assert.match(r.stdout, /dropped\s*:\s*1/, 'the oversized entry is reported dropped');
  assert.ok(!r.stdout.includes('XXXXXXXXXX') && !r.stderr.includes('XXXXXXXXXX'), 'oversized payload never echoed');
  assert.match(r.stderr, /INCOMPLETE/, 'partial load prints the INCOMPLETE notice');
});

// ── CLI end-to-end: conflicting resolutions → exit 0, surfaced on stderr ────────
test('CLI conflicting-resolution: exit 0 but the conflict is surfaced on stderr', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-atlas-accept-cli-'));
  const f = path.join(d, 'conflict.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ pattern: 'CliConflict: same sig', resolution: 'first divergent fix' }),
    JSON.stringify({ pattern: 'CliConflict: same sig', resolution: 'second divergent fix' })
  ].join('\n') + '\n');
  const r = runCli(['--file', f, '--data-dir', d]);
  assert.strictEqual(r.status, 0, `conflicts must not fail the run (both loaded), got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout, /inserted\s*:\s*2/, 'both divergent fixes loaded');
  assert.match(r.stderr, /conflicts\s*:/, 'the conflict is surfaced on stderr');
  assert.match(r.stderr, /DIVERGENT/, 'the conflict notice names the divergence');
});

ch.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
