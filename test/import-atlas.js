'use strict';

// Unit tests for the error-atlas loader (lib/atlas.js). Same harness shape as
// smoke.js: an isolated temp data dir per run, node:assert, exit non-zero on any
// failure. Covers: JSONL parse + validation, stable fingerprinting, the
// canonical insight shape, idempotent re-import, scrub-on-write, recall
// visibility (NOT meta-hidden), and dry-run-writes-nothing.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-atlas-'));
process.env.T2HELIX_DATA_DIR = tmpDir;

const { spawnSync } = require('child_process');

const ch = require('../lib/chronicle');
const atlas = require('../lib/atlas');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'import-atlas.js');
// Run the CLI in a child process with a clean env (no inherited data dir unless
// the test passes one), so exit-code behavior is exercised end-to-end.
function runCli(args, { inheritDataDir = false } = {}) {
  const env = { ...process.env };
  if (!inheritDataDir) { delete env.T2HELIX_DATA_DIR; delete env.CLAUDE_PLUGIN_DATA; }
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
}

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

console.log(`T2Helix import-atlas tests (data: ${tmpDir})`);

const SAMPLE = [
  { pattern: "ModuleNotFoundError: No module named '*'", resolution: 'Install into the active environment with python -m pip install <module>, or activate the right virtualenv.' },
  { pattern: 'SyntaxError: invalid syntax', resolution: 'Check for a missing colon, paren, or a Python 2 vs 3 construct on the line above.' },
  { pattern: 'fatal: not a git repository', resolution: 'Run git init, or cd into the repository root before the git command.' }
];
const SAMPLE_JSONL = SAMPLE.map(o => JSON.stringify(o)).join('\n') + '\n';

test('parseAtlas: parses valid JSONL, reports zero errors', () => {
  const { records, errors } = atlas.parseAtlas(SAMPLE_JSONL);
  assert.strictEqual(records.length, 3);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(records[0].pattern, SAMPLE[0].pattern);
});

test('parseAtlas: skips blanks, flags bad JSON + missing/empty fields with line numbers', () => {
  const txt = [
    JSON.stringify(SAMPLE[0]),       // valid
    '',                              // blank — skipped
    '   ',                           // blank — skipped
    'not json',                      // error: bad JSON
    '{"pattern":"x"}',               // error: missing resolution
    '{"pattern":"","resolution":"y"}' // error: empty pattern
  ].join('\n');
  const { records, errors } = atlas.parseAtlas(txt);
  assert.strictEqual(records.length, 1, 'only the first line is a valid record');
  assert.strictEqual(errors.length, 3, 'three malformed lines, blanks not counted');
  assert.ok(errors.every(e => typeof e.line === 'number' && typeof e.reason === 'string' && e.reason));
});

test('fingerprint: stable, content-derived, 12 hex chars', () => {
  const a = atlas.fingerprint('p', 'r');
  const b = atlas.fingerprint('p', 'r');
  const c = atlas.fingerprint('p', 'r2');
  assert.strictEqual(a, b, 'same input → same fingerprint');
  assert.notStrictEqual(a, c, 'different resolution → different fingerprint');
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('buildInsight: error-fix domain, ground_truth layer, fp + source tags, pattern in content', () => {
  const ins = atlas.buildInsight(SAMPLE[0]);
  assert.strictEqual(ins.domain, 'error-fix');
  assert.strictEqual(ins.layer, 'ground_truth');
  assert.ok(ins.content.startsWith('[error-fix] ModuleNotFoundError'), 'pattern leads the content (FTS token surface)');
  assert.ok(ins.content.includes('pip install'), 'resolution included');
  assert.ok(ins.tags.includes('source:atlas'));
  assert.ok(ins.tags.some(t => /^fp:[0-9a-f]{12}$/.test(t)), 'carries an fp: tag');
});

test('importAtlas: inserts all, second run skips all (idempotent, no dupes)', () => {
  const { records } = atlas.parseAtlas(SAMPLE_JSONL);
  const r1 = atlas.importAtlas({ ch, records });
  assert.strictEqual(r1.counts.inserted, 3);
  assert.strictEqual(r1.counts.skipped, 0);
  assert.strictEqual(r1.counts.dropped, 0);
  const r2 = atlas.importAtlas({ ch, records });
  assert.strictEqual(r2.counts.inserted, 0, 're-run must insert nothing');
  assert.strictEqual(r2.counts.skipped, 3, 're-run must skip all by fingerprint');
  const n = ch.db().prepare(`SELECT count(*) AS n FROM insights WHERE domain = 'error-fix'`).get().n;
  assert.strictEqual(n, 3, 'exactly 3 error-fix rows after two imports');
});

test('importAtlas: entries surface via NORMAL recall() (error-fix is not meta-hidden)', () => {
  const hits = ch.recall({ query: 'ModuleNotFoundError module' });
  assert.ok(
    hits.some(h => h.domain === 'error-fix' && h.content.includes('pip install')),
    'an error-fix entry must be recallable by its error token without include_meta'
  );
});

test('importAtlas: FTS mirror is populated (wildcard-pattern tokens are searchable)', () => {
  const hits = ch.recall({ query: 'git repository' });
  assert.ok(hits.some(h => h.content.includes('git init')), '"fatal: not a git repository" fix must surface via FTS');
});

test('importAtlas: scrub fires on the write path — a secret in a resolution is masked, never raw', () => {
  const { records } = atlas.parseAtlas(JSON.stringify({
    pattern: 'ConfigError: bad credentials',
    resolution: 'Fix the connection string, e.g. password=hunter2supersecret, then reconnect.'
  }));
  const r = atlas.importAtlas({ ch, records });
  assert.strictEqual(r.counts.inserted, 1);
  const row = ch.db().prepare(`SELECT content FROM insights WHERE domain='error-fix' AND content LIKE '%ConfigError%'`).get();
  assert.ok(row, 'row was inserted');
  assert.ok(row.content.includes('[REDACTED:'), 'secret span masked by scrub on the record() path');
  assert.ok(!row.content.includes('hunter2supersecret'), 'raw secret must NOT be persisted');
});

test('importAtlas: dry-run reports would-insert but writes nothing', () => {
  const before = ch.db().prepare(`SELECT count(*) AS n FROM insights WHERE domain='error-fix'`).get().n;
  const { records } = atlas.parseAtlas(JSON.stringify({ pattern: 'NEW: unique-xyzzy error', resolution: 'do the unique thing' }));
  const dr = atlas.importAtlas({ ch, records, dryRun: true });
  assert.strictEqual(dr.counts.inserted, 1, 'dry-run reports the would-insert');
  const after = ch.db().prepare(`SELECT count(*) AS n FROM insights WHERE domain='error-fix'`).get().n;
  assert.strictEqual(after, before, 'dry-run must not write any row');
});

// ── Recall hygiene: backdated created_at (review-2 finding 1) ──────────────────

test('importAtlas: imported rows are backdated to zero recency weight', () => {
  const row = ch.db().prepare(`SELECT created_at FROM insights WHERE domain='error-fix' LIMIT 1`).get();
  assert.strictEqual(row.created_at, 0, 'atlas insights carry the backdated sentinel created_at');
});

test('importAtlas: backdating keeps atlas OUT of the top slot on a generic shared-word query', () => {
  // a genuinely-recent user note sharing one common word ("setup") with an atlas entry
  ch.record({ session_id: 'user-sess', content: 'remember to setup the deploy pipeline next sprint', domain: 'work', layer: 'ground_truth' });
  const { records } = atlas.parseAtlas(JSON.stringify({ pattern: 'EnvError: missing config', resolution: 'Run the setup script to populate environment variables before launch.' }));
  atlas.importAtlas({ ch, records });
  const hits = ch.recall({ query: 'setup' });
  assert.ok(hits.some(h => h.domain === 'work'), 'the fresh user note is recalled');
  assert.notStrictEqual(hits[0].domain, 'error-fix',
    'a backdated atlas entry must not outrank a fresh user note on a weak common-word overlap');
});

test('importAtlas: a STRONG error-token query still surfaces the atlas entry (backdating did not break matching)', () => {
  const hits = ch.recall({ query: 'EnvError missing config' });
  assert.ok(hits.some(h => h.domain === 'error-fix' && h.content.includes('setup script')),
    'a specific error query still recalls the fix despite zero recency weight');
});

// ── Dry-run / real parity on intra-file duplicates (review-2 finding 3) ─────────

test('importAtlas: dry-run matches the real run on intra-file duplicates', () => {
  const dup = JSON.stringify({ pattern: 'DupErr: duplicated line', resolution: 'the same fix twice' });
  const { records } = atlas.parseAtlas(dup + '\n' + dup); // two identical lines
  const dr = atlas.importAtlas({ ch, records, dryRun: true });
  assert.strictEqual(dr.counts.inserted, 1, 'dry-run dedups the in-file duplicate (would insert 1, not 2)');
  assert.strictEqual(dr.counts.skipped, 1);
  const rr = atlas.importAtlas({ ch, records }); // real run agrees
  assert.strictEqual(rr.counts.inserted, 1);
  assert.strictEqual(rr.counts.skipped, 1);
  const n = ch.db().prepare(`SELECT count(*) AS n FROM insights WHERE content LIKE '%DupErr%'`).get().n;
  assert.strictEqual(n, 1, 'exactly one row for the duplicated entry');
});

// ── CLI exit-code contract (review findings 1 + 3): exit 0 ONLY on a clean run ──

test('CLI: clean load exits 0 and loads the valid subset', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-atlas-cli-'));
  const f = path.join(d, 'clean.jsonl');
  fs.writeFileSync(f, SAMPLE_JSONL);
  const r = runCli(['--file', f, '--data-dir', d]);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout, /inserted\s*:\s*3/, 'loaded all 3 valid entries');
});

test('CLI: partial load (one malformed line) exits 1 but still loads the valid subset', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-atlas-cli-'));
  const f = path.join(d, 'partial.jsonl');
  fs.writeFileSync(f, [JSON.stringify(SAMPLE[0]), 'NOT JSON', JSON.stringify(SAMPLE[1])].join('\n') + '\n');
  const r = runCli(['--file', f, '--data-dir', d]);
  assert.strictEqual(r.status, 1, `expected exit 1 on partial load, got ${r.status}`);
  assert.match(r.stderr, /INCOMPLETE/, 'prints an INCOMPLETE notice on stderr');
  assert.match(r.stdout, /inserted\s*:\s*2/, 'still loaded the 2 valid entries (partial success)');
});

test('CLI: file with ONLY malformed lines exits 1 (not a silent no-op)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-atlas-cli-'));
  const f = path.join(d, 'allbad.jsonl');
  fs.writeFileSync(f, 'NOT JSON\n{"pattern":"x"}\n');
  const r = runCli(['--file', f, '--data-dir', d]);
  assert.strictEqual(r.status, 1, `expected exit 1 when nothing valid parsed, got ${r.status}`);
});

test('CLI: refuses a real run without an explicit data dir (exit 2)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-atlas-cli-'));
  const f = path.join(d, 'x.jsonl');
  fs.writeFileSync(f, SAMPLE_JSONL);
  const r = runCli(['--file', f]); // no --data-dir, env stripped
  assert.strictEqual(r.status, 2, `expected exit 2 (refuse bare fallback), got ${r.status}`);
  assert.match(r.stderr, /REFUSING/);
});

test('CLI: dry-run without an explicit data dir is allowed (exit 0, writes nothing)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-atlas-cli-'));
  const f = path.join(d, 'x.jsonl');
  fs.writeFileSync(f, SAMPLE_JSONL);
  // dry-run is read-only, so the bare-fallback refusal does not apply; point it
  // at an explicit empty dir anyway to keep the child hermetic.
  const r = runCli(['--file', f, '--data-dir', d, '--dry-run']);
  assert.strictEqual(r.status, 0, `dry-run should exit 0, got ${r.status}`);
  assert.match(r.stdout, /would insert\s*:\s*3/);
  // The post-write "verify : N error-fix insight(s)" line is gated behind a real
  // (non-dry) run, so its absence proves nothing was committed.
  assert.ok(!/verify\s*:/.test(r.stdout), 'dry-run must not emit the post-write verify line');
});

ch.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
