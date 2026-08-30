'use strict';

// THE PROPERTY: the `secret-assign` leg fires on a labelled assignment only when
// the VALUE is a literal. An assignment whose value is code — a variable, a call,
// a file read, a subscript, a regex — is not a credential paste and must not
// stall the seat.
//
// The leg is measured on THREE surfaces, not one, because they can disagree:
//
//   1. secrets.looksLikeSecret()  the regex itself
//   2. compass.classify()         the legacy gate, which is what the PreToolUse
//                                 hook actually consumes (rule `credential-paste`,
//                                 pattern_source `secrets`)
//   3. classifyV2() semantic      lib/compass-semantic.js evaluateCredentialPaste()
//                                 re-tests the SAME DETECTION_REGEX per-haystack
//                                 (argv item, full_argv, segment). A narrowing
//                                 that fixed the legacy leg and not this one would
//                                 leave the stall in place in enforce mode.
//
// AND the split this file exists to hold: detection was narrowed, REDACTION was
// NOT. `lib/secrets` used one `src` for both, so narrowing the detector would
// silently have narrowed the chronicle write-path masker too. The invariant that
// matters is DETECTION ⊆ REDACTION — anything flagged must be maskable — and it
// is preserved by narrowing detection, never by narrowing redaction. Masking a
// code expression costs nothing; failing to mask a secret is the v0.1 leak. The
// redaction arm below is the proof, not the prose.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-secret-assign-'));
process.env.T2HELIX_DATA_DIR = path.join(tmpRoot, 'chronicle');
process.env.T2HELIX_POLICY_DIR = '';

const secrets = require('../lib/secrets');
const compass = require('../lib/compass');
const { classifyV2 } = require('../lib/compass-v2');
const {
  MUST_NOT_FIRE, MUST_FIRE, ACCEPTED_RESIDUE, DELIBERATE_LOSSES
} = require('./fixtures/secret-assign-vectors');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const legacy = cmd => compass.classify({ tool_name: 'Bash', tool_input: { command: cmd } });

function semantic(cmd) {
  const prev = process.env.T2HELIX_COMPASS_V2;
  process.env.T2HELIX_COMPASS_V2 = 'shadow';
  try {
    return classifyV2({ tool_name: 'Bash', tool_input: { command: cmd } }, {});
  } finally {
    if (prev === undefined) delete process.env.T2HELIX_COMPASS_V2;
    else process.env.T2HELIX_COMPASS_V2 = prev;
  }
}

// ── ARM 1: the regex ────────────────────────────────────────────────────────

test('detector: an assignment whose value is an expression is not a credential', () => {
  const wrong = MUST_NOT_FIRE.filter(v => secrets.looksLikeSecret(v.text));
  assert.deepEqual(
    wrong.map(v => `${v.name} (${v.shape})`), [],
    'these are code, not credentials — a PAUSE here is a false soft-deny'
  );
});

test('detector: every literal secret is still detected', () => {
  const lost = MUST_FIRE.filter(v => !secrets.looksLikeSecret(v.text));
  assert.deepEqual(
    lost.map(v => `${v.name} (${v.leg})`), [],
    'a detection LOSS — the release rule forbids being worse than base on any carrier'
  );
});

// ── ARM 2: the gate the hook actually consumes ──────────────────────────────

test('legacy gate: expression-valued assignments classify OPEN', () => {
  const stalled = MUST_NOT_FIRE
    .map(v => ({ v, r: legacy(v.text) }))
    .filter(({ r }) => r.classification !== 'OPEN');
  assert.deepEqual(
    stalled.map(({ v, r }) => `${v.name} -> ${r.classification}/${r.rule_id}`), [],
    'the PreToolUse hook would soft-deny these'
  );
});

test('legacy gate: literal secrets still classify PAUSE via credential-paste', () => {
  const cleared = MUST_FIRE
    .map(v => ({ v, r: legacy(v.text) }))
    .filter(({ r }) => r.classification !== 'PAUSE' || r.rule_id !== 'credential-paste');
  assert.deepEqual(
    cleared.map(({ v, r }) => `${v.name} -> ${r.classification}/${r.rule_id}`), [],
    'a real credential reached the tool without a soft-deny'
  );
});

// ── ARM 3: the semantic leg re-tests the same regex per haystack ────────────

test('semantic leg: expression-valued assignments are not escalated to PAUSE', () => {
  const stalled = MUST_NOT_FIRE
    .map(v => ({ v, s: semantic(v.text).semantic }))
    .filter(({ s }) => s && s.classification === 'PAUSE');
  assert.deepEqual(
    stalled.map(({ v, s }) => `${v.name} -> ${s.rule_id}`), [],
    'evaluateCredentialPaste() re-tests DETECTION_REGEX per argv haystack; '
    + 'fixing only the legacy leg leaves the stall reachable in enforce mode'
  );
});

// ── ARM 4: redaction stayed WIDER than detection (the split, proven) ────────

test('split: narrowing detection did NOT narrow the write-path masker', () => {
  // Both values are 8+ chars, so base masked them; both are expressions, so the
  // detector no longer flags them. Redaction must be unchanged: masking a code
  // expression is harmless, and a redactor that quietly stopped masking would be
  // strictly worse than the stall this change removes.
  const heredoc = MUST_NOT_FIRE.find(v => v.name === 'py-heredoc-reads-env-file').text;
  const brace = MUST_NOT_FIRE.find(v => v.name === 'brace-expansion-value').text;

  for (const [label, text] of [['heredoc', heredoc], ['brace-expansion', brace]]) {
    assert.equal(secrets.looksLikeSecret(text), false, `${label}: detection is off`);
    assert.notEqual(
      secrets.redactSecrets(text), text,
      `${label}: redaction must still mask — detection ⊆ redaction, never the reverse`
    );
    assert.match(
      secrets.redactSecrets(text), /\[REDACTED:secret-assign:/,
      `${label}: masked by the secret-assign redactor specifically`
    );
  }
});

test('split: the detection ⊆ redaction invariant holds on every vector', () => {
  // `nameOnly` vectors are exempt: NAME_ONLY_DETECT matches a key NAME with no
  // value span, so it has nothing to mask and cannot leak a value. Every
  // value-bearing detection must be maskable.
  const all = [...MUST_NOT_FIRE, ...MUST_FIRE, ...ACCEPTED_RESIDUE, ...DELIBERATE_LOSSES];
  const leaks = all.filter(v =>
    !v.nameOnly && secrets.looksLikeSecret(v.text) && secrets.redactSecrets(v.text) === v.text
  );
  assert.deepEqual(
    leaks.map(v => v.name), [],
    'detected but not maskable — this is the v0.2.0 detect-but-do-not-mask leak'
  );
});

test('split: scrub() remains a redactor fixed point on every vector', () => {
  const all = [...MUST_NOT_FIRE, ...MUST_FIRE, ...ACCEPTED_RESIDUE, ...DELIBERATE_LOSSES];
  for (const v of all) {
    const out = secrets.scrub(v.text);
    assert.equal(secrets.redactSecrets(out), out, `${v.name}: scrub output is not a fixed point`);
  }
});

// ── ARM 4b: the narrowing is STRICT, proved on inputs rather than argued ────

test('split: detectSrc is a strict NARROWING of src — no input is widened', () => {
  // The directional invariant (detection ⊆ redaction) is what keeps the v0.2.0
  // leak closed, and it is a property of the two regexes, not of a vector list.
  // A `detectSrc` that matched anything its `src` does not would be a detection
  // the redactor cannot mask. Walked, not asserted — the house convention that
  // caught the url-auth rewrite's real behaviour (see lib/secrets.js).
  const p = secrets.PATTERNS.find(x => x.kind === 'secret-assign');
  assert.ok(p && p.detectSrc, 'secret-assign must carry a detectSrc');
  const wide = new RegExp(p.src, 'i');
  const narrow = new RegExp(p.detectSrc, 'i');

  const KEYWORDS = [
    'password', 'passwd', 'secret', 'api_key', 'api-key', 'apikey', 'access_key',
    'auth_token', 'token', 'DB_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'API_TOKEN',
    'tokenizer', 'tokens', 'mypassword', 'secretariat'
  ];
  const SEPS = ['=', ':', ' = ', ' : ', '":"', "'='"];
  const QUOTES = ['', '"', "'"];
  const VALUES = [
    // literals, spanning the floor
    '', 'z', 'zzz', 'abcdefg', 'abcdefgh', 'hunter2hunter2', 'AbCdEfGhIjKlMnOp',
    'sup3rSecretValue12345', 'P@ssw0rd!Sup3r#SecretValue',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
    // expressions — every arm of EXPRESSION_VALUE
    '$BRIDGE_TOKEN', '${VAULT_LOOKUP_RESULT}', '$(cat ~/.config/x.env)',
    '`cat /run/secrets/x`', '[l.split("=",1)[1] for l in f][0]', '[^ ]+',
    '[A-Za-z0-9_-]{12,}', '(a or b)', '{"k":"v"}', '<<EOF', '<redacted>',
    'getpass()', 'os.environ["X"]', 'os.path.expanduser("~/.x")',
    'self.session.token', 'access_token_variable', 'request.headers.get("A")',
    // adversarial around the lookahead boundary
    '$', '[', 'a(', 'a[', 'a.b', 'a.'.repeat(40) + 'b(', 'x'.repeat(70) + '(',
    '[REDACTED:secret-assign:deadbeef]'
  ];
  const PREFIXES = ['', 'echo ', 'export ', 'curl -H "', 'run --flag '];

  let bothHit = 0, narrowed = 0, widened = [];
  for (const k of KEYWORDS) {
    for (const sep of SEPS) {
      for (const q of QUOTES) {
        for (const v of VALUES) {
          for (const pre of PREFIXES) {
            const s = `${pre}${k}${sep}${q}${v}`;
            const w = wide.test(s), n = narrow.test(s);
            if (n && !w) { if (widened.length < 5) widened.push(s); }
            else if (n && w) bothHit++;
            else if (w && !n) narrowed++;
          }
        }
      }
    }
  }
  const total = KEYWORDS.length * SEPS.length * QUOTES.length * VALUES.length * PREFIXES.length;
  console.log(`        [note] secret-assign narrowing: ${total} inputs — `
    + `both-hit:${bothHit} narrowed:${narrowed} widened:${widened.length}`);
  assert.deepEqual(widened, [],
    'detectSrc matched where src does not — a detection the redactor cannot mask');
  assert.ok(narrowed > 0, 'the walk must actually exercise the narrowing, not just agree');
  assert.ok(bothHit > 0, 'the walk must also cover inputs both sides still catch');
});

// ── ARM 5: characterization — cost recorded, not claimed to be zero ─────────

test('CHARACTERIZATION: a bare or dotted identifier value still fires', () => {
  for (const v of ACCEPTED_RESIDUE) {
    assert.equal(
      secrets.looksLikeSecret(v.text), true,
      `${v.name} stopped firing. That may be an improvement, but it is a behaviour `
      + `change this file asserts deliberately (${v.why}) — move the vector, do not delete it.`
    );
  }
});

test('CHARACTERIZATION: the name-only leg goes quiet on an expression value', () => {
  // Base classified `AWS_SECRET_ACCESS_KEY=$(vault read …)` as PAUSE purely on
  // the KEY NAME. Reading from a secret store is not pasting a credential, so
  // this is now OPEN — a deliberate, recorded loss, not an oversight.
  for (const v of DELIBERATE_LOSSES) {
    assert.equal(secrets.looksLikeSecret(v.text), false, `${v.name}: ${v.why}`);
    assert.equal(legacy(v.text).classification, 'OPEN', `${v.name}: gate must clear it`);
  }
});

test('CHARACTERIZATION: a bare key name with no assignment still warns', () => {
  // The name-only leg is narrowed only in ASSIGNMENT position. A bare mention
  // with no value is still an advisory PAUSE — that arm was not touched.
  for (const cmd of ['echo $' + 'api_key', 'cat ~/.aws/' + 'secret_access_key']) {
    assert.equal(secrets.looksLikeSecret(cmd), true, `name-only advisory lost for: ${cmd}`);
  }
});

// ── run ─────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
console.log('T2Helix secret-assign literal-value tests');
for (const entry of tests) {
  try {
    entry.fn();
    passed++;
    console.log(`  PASS  ${entry.name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL  ${entry.name}: ${error.message}`);
  }
}
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
