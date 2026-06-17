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

const ch = require('../lib/chronicle');
const atlas = require('../lib/atlas');

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

ch.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
