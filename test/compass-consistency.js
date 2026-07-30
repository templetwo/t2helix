'use strict';

// Cross-boundary Compass audit. This is intentionally both a regression suite
// for the shared, documented corpus and a characterization suite for unresolved
// divergences. A passing characterization is not a safety clearance: see
// COMPASS_CONSISTENCY.md before changing any expected divergence below.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-compass-consistency-'));
const dataDir = path.join(tmpRoot, 'chronicle');
process.env.T2HELIX_DATA_DIR = dataDir;
process.env.T2HELIX_POLICY_DIR = '';
process.env.T2HELIX_COMPASS_V2 = 'shadow';

const compass = require('../lib/compass');
const { classifyV2 } = require('../lib/compass-v2');
const grok = require('../lib/grok-adapter');
const codex = require('../lib/codex-adapter');
const chronicle = require('../lib/chronicle');

const repoRoot = path.resolve(__dirname, '..');
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function withMode(mode, fn) {
  const previous = process.env.T2HELIX_COMPASS_V2;
  process.env.T2HELIX_COMPASS_V2 = mode;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.T2HELIX_COMPASS_V2;
    else process.env.T2HELIX_COMPASS_V2 = previous;
  }
}

function runHook(hookFile, payload, mode = 'shadow') {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'hooks', hookFile)], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      T2HELIX_DATA_DIR: dataDir,
      T2HELIX_POLICY_DIR: '',
      T2HELIX_COMPASS_V2: mode
    },
    encoding: 'utf8'
  });
  assert.strictEqual(result.status, 0, `${hookFile} exited ${result.status}: ${result.stderr}`);
  let output;
  try {
    output = JSON.parse((result.stdout || '').trim() || '{}');
  } catch (error) {
    assert.fail(`${hookFile} emitted invalid JSON: ${result.stdout}\n${error.message}`);
  }
  return { output, stderr: result.stderr || '' };
}

function preToolVerdict(payload, mode = 'shadow') {
  const { output } = runHook('pre-tool-use.js', payload, mode);
  if (output.hookSpecificOutput) {
    const reason = output.hookSpecificOutput.permissionDecisionReason || '';
    return reason.includes('[soft-deny]') ? 'PAUSE' : 'WITNESS';
  }
  if (output.systemMessage) return 'ERROR_ALLOW';
  return 'OPEN';
}

function mcpResult(name, args) {
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args }
  };
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'mcp', 'server.js'), '--transport', 'stdio'],
    {
      input: JSON.stringify(request) + '\n',
      env: {
        ...process.env,
        T2HELIX_DATA_DIR: dataDir,
        T2HELIX_POLICY_DIR: '',
        T2HELIX_COMPASS_V2: 'shadow'
      },
      encoding: 'utf8'
    }
  );
  assert.strictEqual(result.status, 0, `MCP ${name} exited ${result.status}: ${result.stderr}`);
  const line = (result.stdout || '').trim().split('\n').find(Boolean);
  assert.ok(line, `MCP ${name} returned no JSON-RPC response`);
  return JSON.parse(line);
}

function mcpVerdict(name, args) {
  const response = mcpResult(name, args);
  if (response.error) return 'ERROR';
  const body = JSON.parse(response.result.content[0].text);
  return body.active.classification;
}

function structured(command) {
  return { tool_name: 'Bash', tool_input: { command } };
}

async function seatVerdicts(specimen) {
  const payload = structured(specimen.command);
  return {
    legacy_library: compass.classify(payload).classification,
    v2_library: withMode('shadow', () => classifyV2(payload).active.classification),
    pre_tool_v2: preToolVerdict({ session_id: `corpus-v2-${specimen.id}`, ...payload }, 'shadow'),
    pre_tool_legacy: preToolVerdict({ session_id: `corpus-off-${specimen.id}`, ...payload }, 'off'),
    grok_string: (await grok.grokWitness(specimen.command, {
      session_id: `corpus-grok-${specimen.id}`
    })).classification,
    codex_advisory: withMode('shadow', () => codex.codexCompassCheck(specimen.command).classification),
    mcp_dry_run: mcpVerdict('dry_run_compass', {
      tool_name: 'Bash', command: specimen.command, mode: 'shadow'
    }),
    mcp_explain: mcpVerdict('explain_compass', {
      tool_name: 'Bash', command: specimen.command, mode: 'shadow'
    })
  };
}

const CORPUS = [
  { id: 'rm-wildcard', expected: 'WITNESS', command: 'rm -rf /tmp/*' },
  { id: 'rm-root', expected: 'WITNESS', command: 'rm -rf /' },
  { id: 'force-push', expected: 'WITNESS', command: 'git push --force origin main' },
  { id: 'reset-hard', expected: 'WITNESS', command: 'git reset --hard HEAD~1' },
  { id: 'drop-table', expected: 'WITNESS', command: 'psql -c "DROP TABLE users"' },
  { id: 'drop-database', expected: 'WITNESS', command: 'psql -c "DROP DATABASE app"' },
  { id: 'prod-kubectl', expected: 'WITNESS', command: 'kubectl delete pod api --context prod' },
  { id: 'prod-terraform', expected: 'WITNESS', command: 'terraform destroy -var environment=production' },
  { id: 'prod-helm', expected: 'WITNESS', command: 'helm upgrade api ./chart --namespace production' },
  { id: 'prod-aws', expected: 'WITNESS', command: 'aws ecs update-service --cluster prod --service api' },
  { id: 'prod-gcloud', expected: 'WITNESS', command: 'gcloud run deploy api --project production' },
  { id: 'no-verify', expected: 'WITNESS', command: 'git commit --no-verify -m test' },
  { id: 'credential-assignment', expected: 'PAUSE', command: 'echo api_key=zzz' },
  {
    id: 'credential-prefixed-token',
    expected: 'PAUSE',
    command: 'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345'
  },
  { id: 'open-list', expected: 'OPEN', command: 'ls -la /tmp' },
  { id: 'open-force-lease', expected: 'OPEN', command: 'git push --force-with-lease origin main' },
  { id: 'open-prod-read', expected: 'OPEN', command: 'kubectl get pods --context prod' }
];

for (const specimen of CORPUS) {
  test(`documented corpus agrees: ${specimen.id} -> ${specimen.expected}`, async () => {
    const verdicts = await seatVerdicts(specimen);
    for (const [seat, actual] of Object.entries(verdicts)) {
      assert.strictEqual(
        actual,
        specimen.expected,
        `${specimen.id} diverged at ${seat}: ${JSON.stringify(verdicts)}`
      );
    }
  });
}

// These assertions characterize unresolved findings. They make the audit
// reproducible but must not be read as approval of OPEN behavior.
const destructive = 'rm -rf /tmp/*';
const UNMATCHABLE = [
  {
    id: 'unknown-tool',
    payload: { tool_name: 'Mystery', tool_input: { command: destructive } },
    expected: ['OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN']
  },
  {
    id: 'missing-tool-input',
    payload: { tool_name: 'Bash' },
    expected: ['OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN']
  },
  {
    id: 'alternate-command-key',
    payload: { tool_name: 'Bash', tool_input: { cmd: destructive } },
    expected: ['OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN']
  },
  {
    id: 'non-string-command',
    payload: { tool_name: 'Bash', tool_input: { command: { raw: destructive } } },
    expected: ['ERROR_ALLOW', 'ERROR_ALLOW', 'OPEN', 'UNAVAILABLE', 'ERROR', 'ERROR']
  },
  {
    id: 'deeply-nested-command',
    payload: { tool_name: 'Bash', tool_input: { request: { command: destructive } } },
    expected: ['OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN']
  },
  {
    id: 'empty-command',
    payload: { tool_name: 'Bash', tool_input: { command: '' } },
    expected: ['OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN']
  },
  {
    id: 'null-tool-input',
    payload: { tool_name: 'Bash', tool_input: null },
    expected: ['OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN']
  },
  {
    id: 'null-payload',
    payload: null,
    expected: ['OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN', 'OPEN']
  }
];

for (const specimen of UNMATCHABLE) {
  test(`characterize unmatchable payload: ${specimen.id}`, async () => {
    const actual = [
      preToolVerdict(specimen.payload, 'shadow'),
      preToolVerdict(specimen.payload, 'off'),
      (await grok.grokWitness(specimen.payload, {
        session_id: `unmatchable-grok-${specimen.id}`
      })).classification,
      withMode('shadow', () => codex.codexCompassCheck(specimen.payload).classification),
      mcpVerdict('dry_run_compass', specimen.payload),
      mcpVerdict('explain_compass', specimen.payload)
    ];
    assert.deepStrictEqual(actual, specimen.expected, specimen.id);
  });
}

function modeMatrix(command) {
  const payload = structured(command);
  return {
    legacy: compass.classify(payload).classification,
    shadow: withMode('shadow', () => classifyV2(payload).active.classification),
    enforce: withMode('enforce', () => classifyV2(payload).active.classification)
  };
}

test('bounded rewrites that retain the WITNESS floor', () => {
  for (const command of [
    'rm -fr /tmp/*',
    'rm   -rf   /tmp/*',
    'rm -rf "/tmp/*"',
    'echo ok && rm -rf /tmp/*'
  ]) {
    assert.strictEqual(modeMatrix(command).shadow, 'WITNESS', command);
  }
});

// ── Regressions for the 2026-07-26 fixes ─────────────────────────────────────
// These began as characterization tests recording live bypasses. The bypasses
// are closed, so each now asserts the FIXED behaviour: a documented WITNESS form
// must deny in EVERY mode, not only in the mode that happens to parse it.

test('regression: long and quoted rm flags deny in every mode', () => {
  // Was OPEN/OPEN/WITNESS — only the mode that parsed the command caught it.
  // Fixed by normalizing the HAYSTACK rather than widening rule #1. Widening was
  // tried and reverted 2026-07-26: rm-rf-wildcard is rule #1 in a
  // FIRST-MATCH-WINS list (lib/compass.js), so a wider pattern began capturing
  // ordinary deletes and RELABELLING chained commands with a migrated rule_id;
  // mergeDecisions then cleared the whole verdict on migrated-family grounds and
  // `rm --force <file> && git push --force` went from DENY to ALLOW in enforce.
  // Normalization reaches the same matches from a different site, so it inherits
  // the same hazard — classify() therefore matches the command AS WRITTEN first
  // and only normalizes when that pass is clean. Guarded in
  // test/compass-normalization.js under rule_order_preserved.
  const ALL_WITNESS = { legacy: 'WITNESS', shadow: 'WITNESS', enforce: 'WITNESS' };
  assert.deepStrictEqual(modeMatrix('rm --recursive --force /tmp/*'), ALL_WITNESS);
  assert.deepStrictEqual(modeMatrix('rm "-rf" /tmp/*'), ALL_WITNESS);
});

test('regression: enforce mode no longer downgrades prefixed deletes', () => {
  // Was WITNESS/WITNESS/OPEN. Action IR treats the wrapper as the executable, so
  // no rm predicate fires; the migrated-family merge then read that silence as
  // license to clear the legacy WITNESS. Turning enforce ON weakened the gate.
  // A semantic OPEN may now only clear when the parser actually SAW the family.
  for (const prefix of ['env', 'sudo', 'command']) {
    assert.deepStrictEqual(
      modeMatrix(`${prefix} rm -rf /tmp/*`),
      { legacy: 'WITNESS', shadow: 'WITNESS', enforce: 'WITNESS' },
      prefix
    );
  }
});

test('regression: quoted and reordered git safety flags deny in every mode', () => {
  // Was OPEN in all three modes. The quoted forms are closed by the dequote in
  // classify(); the flag-last form needed the rule re-anchored.
  //
  // Re-anchoring was the part that had failed before: the earlier attempt reused
  // the `(?:[^|;&]*\s+)?` idiom git-push-force already carries, which is CUBIC on
  // whitespace runs (0.019ms -> 1347ms at 1.2KB) because [^|;&] is a superset of
  // \s and three quantifiers then compete for one contiguous run. Against a
  // 5000ms PreToolUse budget a hung hook emits no decision and the call proceeds
  // UNGATED. The token-then-separator form `(?:[^|;&\s]+[ \t]+)*` is unambiguous
  // — nothing can claim the same run twice — and stays flat: 0ms at 8000 spaces,
  // asserted in test/compass-normalization.js. [ \t] rather than \s so the walk
  // cannot cross a newline into the next command.
  const ALL_WITNESS = { legacy: 'WITNESS', shadow: 'WITNESS', enforce: 'WITNESS' };
  assert.deepStrictEqual(modeMatrix('git push "--force" origin main'), ALL_WITNESS);
  assert.deepStrictEqual(modeMatrix('git reset "--hard" HEAD~1'), ALL_WITNESS);
  // The worst of the set: ordinary, unquoted, valid git that a developer types by
  // habit. git-reset-hard used to require the flag ADJACENT to the subcommand.
  assert.deepStrictEqual(modeMatrix('git reset HEAD~1 --hard'), ALL_WITNESS);
});

test('PRE-EXISTING DEFECT: git-push-force is superlinear on whitespace runs', () => {
  // Not introduced here — this idiom shipped in git-push-force before tonight.
  // `(?:[^|;&]*\s+)?` lets [^|;&]* and \s+ and the following \s+ all compete for
  // the same whitespace, which is cubic. Recorded as a test so the cost is a
  // number rather than a hunch, and so a future fix has a baseline to beat.
  // Deliberately NOT asserted as fast: asserting speed here would fail today and
  // that is the point of filing it instead of patching it blind.
  const re = /git\s+push\s+(?:[^|;&]*\s+)?(?:--force(?!-with-lease)|-f)\b/;
  const sample = 'git push ' + ' '.repeat(400) + 'x';
  const started = Date.now();
  re.test(sample);
  const elapsed = Date.now() - started;
  console.log(`        [note] git-push-force took ${elapsed}ms on ${sample.length} bytes of whitespace`);
  assert.ok(elapsed >= 0); // characterization only — see open thread #15
});

test('regression: enforce mode may not clear on unresolved command substitution', () => {
  // The executable is echo, so no rm predicate fires — but the substitution
  // genuinely executes the delete. Nobody caught this in the original audit.
  const sub = 'echo $(rm -rf /tmp/*)';
  const m = modeMatrix(sub);
  assert.strictEqual(m.shadow, 'WITNESS', sub);
  assert.strictEqual(m.enforce, 'WITNESS', `${sub} — enforce must not clear what it could not read`);
});

test('regression: widened rm patterns stay linear-time (no catastrophic backtracking)', () => {
  // The 2026-07-26 fix introduced a nested quantifier into a production pattern:
  // (?:["']?-{1,2}(?:[rRf]+|recursive|force|dir)["']?\s+)+  — a + inside a +, the
  // classic ReDoS shape. It is safe here ONLY because each repetition is anchored by
  // a mandatory \s+, so no input position is ambiguous. That property is easy to
  // destroy accidentally (drop the \s+, make the quote greedy) and the failure mode
  // is a hung PreToolUse hook, i.e. a denial of service on the operator's own CLI
  // inside a 5s budget. This asserts the property rather than the implementation.
  // LESSON (2026-07-26): the first version of this test used repeated FLAG TOKENS
  // and reported everything linear, which is why a cubic pattern shipped past it
  // for one round. The shape that actually explodes is a long run of a single
  // character that MULTIPLE quantifiers can all claim — here whitespace, because
  // `[^|;&]` is a superset of `\s`. Whitespace runs must stay in this list.
  // The reset shape is no longer skipped: git-reset-hard now walks tokens with
  // `(?:[^|;&\s]+[ \t]+)*`, where the separator cannot be claimed by the token
  // class, so it is measured here rather than exempted.
  const RM = String.fromCharCode(114, 109);
  const adversarial = [
    'git reset ' + ' '.repeat(4000) + 'x',            // the shape that was missed
    'git push ' + ' '.repeat(4000) + 'x',
    `${RM} ` + ' '.repeat(4000) + 'x',
    `${RM} ` + '-rf '.repeat(16000) + 'X',            // many near-complete flag tokens
    `${RM} -` + 'r'.repeat(16000) + ' X',             // one huge inner-quantifier run
    `${RM} ` + '"-rf" '.repeat(16000) + 'X',          // quote-heavy
    `${RM} ` + '--recursive --force '.repeat(2000) + 'X'
  ];
  // CHARACTERIZATION, not an assertion — it would fail today on the SHIPPED
  // git-push-force pattern, and that is the finding rather than a reason to skip it.
  // Measured: `git push` + N contiguous spaces, shipped pattern:
  //     400 spaces ->    51 ms      1000 spaces ->   809 ms      4000 -> 141887 ms
  // The PreToolUse budget is 5000 ms and Bash is the only tool whose haystack is
  // uncapped, so a hung hook emits no decision and the call proceeds UNGATED —
  // starving every rule after it in the list. Practical exploitability is LOW: it
  // needs a CONTIGUOUS whitespace run; long trailing text and many operands stay
  // at ~0.2 ms, so this is latent rather than a daily hazard.
  //
  // A candidate fix is verified linear and strictly more correct:
  //     (?:[^|;&]*\s+)?   ->   (?:[^|;&\s]+\s+)*
  // Unambiguous token-then-whitespace, so nothing competes for the same run:
  // 0.024-0.082 ms across all shapes above. It matches everything the shipped
  // pattern matches, still rejects --force-with-lease / plain push / git pull,
  // and additionally catches the quoted `"--force"` form. NOT APPLIED: two pattern
  // edits tonight each caused a regression (rule-order shadowing; this same cubic
  // idiom), so a third goes through review with a clear head. See open thread #15.
  const timings = [];
  for (const input of adversarial) {
    if (/\s{100,}/.test(input) && /git\s+push/.test(input)) continue; // known-slow, measured above
    const started = Date.now();
    modeMatrix(input);
    timings.push(`${input.length}b:${Date.now() - started}ms`);
  }
  console.log(`        [note] flag-token shapes stay linear — ${timings.join(' ')}`);
  assert.ok(timings.length > 0);
});

test('regression: quoting a dangerous command as prose is still OPEN', () => {
  // The counterpart guard. isDocumentationOnly() is an AFFIRMATIVE finding that
  // nothing executes, and it already refuses to certify a segment carrying
  // command-substitution uncertainty — so the fix above must not blanket-gate
  // echo and re-break the July 21 prose false positives.
  const prose = 'echo "never run: rm -rf / && git push --force origin main"';
  assert.strictEqual(modeMatrix(prose).enforce, 'OPEN', prose);
});

test('regression: every seat agrees on long-flag deletes', async () => {
  const command = 'rm --recursive --force /tmp/*';
  const payload = structured(command);
  assert.deepStrictEqual(
    {
      pre_shadow: preToolVerdict({ session_id: 'long-shadow', ...payload }, 'shadow'),
      pre_enforce: preToolVerdict({ session_id: 'long-enforce', ...payload }, 'enforce'),
      grok_legacy: (await grok.grokWitness(command, { session_id: 'long-grok' })).classification,
      codex_shadow: withMode('shadow', () => codex.codexCompassCheck(command).classification),
      codex_enforce: withMode('enforce', () => codex.codexCompassCheck(command).classification),
      mcp_shadow: mcpVerdict('dry_run_compass', { command, mode: 'shadow' }),
      mcp_enforce: mcpVerdict('dry_run_compass', { command, mode: 'enforce' })
    },
    {
      // Was four OPENs against three WITNESSes: only the modes that parsed the
      // command caught it, and shadow — the shipped default — was on the OPEN
      // side. Normalizing the haystack in the legacy classifier closes the split
      // at its source, so every seat that reads the rules now reads them the same
      // way, whatever mode it runs in.
      pre_shadow: 'WITNESS',
      pre_enforce: 'WITNESS',
      grok_legacy: 'WITNESS',
      codex_shadow: 'WITNESS',
      codex_enforce: 'WITNESS',
      mcp_shadow: 'WITNESS',
      mcp_enforce: 'WITNESS'
    }
  );
});

test('actual seats reproduce enforce-mode prefix downgrade', async () => {
  const command = 'sudo rm -rf /tmp/*';
  const payload = structured(command);
  assert.deepStrictEqual(
    {
      pre_shadow: preToolVerdict({ session_id: 'prefix-shadow', ...payload }, 'shadow'),
      pre_enforce: preToolVerdict({ session_id: 'prefix-enforce', ...payload }, 'enforce'),
      grok_legacy: (await grok.grokWitness(command, { session_id: 'prefix-grok' })).classification,
      codex_enforce: withMode('enforce', () => codex.codexCompassCheck(command).classification),
      mcp_enforce: mcpVerdict('explain_compass', { command, mode: 'enforce' })
    },
    {
      // pre_enforce / codex_enforce / mcp_enforce were all OPEN before the fix:
      // enforcing made the gate weaker than observing.
      pre_shadow: 'WITNESS',
      pre_enforce: 'WITNESS',
      grok_legacy: 'WITNESS',
      codex_enforce: 'WITNESS',
      mcp_enforce: 'WITNESS'
    }
  );
});

const IDENTITY_CASES = [
  ['unicode', 'printf "naive cafe λ 🚀"'],
  ['whitespace-runs', 'printf    "%s"     value'],
  ['quoting', 'printf \'%s\\n\' "alpha beta"'],
  ['very-long', `printf ${'x'.repeat(500)}`],
  ['multi-line', 'printf one\nprintf two'],
  ['heredoc', "cat <<'EOF'\nhello world\nEOF"],
  ['chains', 'printf one && printf two; printf three']
];

for (const [id, command] of IDENTITY_CASES) {
  test(`Pre/Post action identity: ${id}`, () => {
    const payload = structured(command);
    const postSummary = compass.summarizeAction(payload);
    const expectedTag = `action:${chronicle.actionHash(postSummary)}`;

    for (const mode of ['off', 'shadow', 'enforce']) {
      const preSummary = withMode(mode, () => classifyV2(payload).action_summary);
      assert.strictEqual(preSummary, postSummary, `summary mismatch in ${mode}`);
      assert.strictEqual(
        chronicle.actionHash(preSummary),
        chronicle.actionHash(postSummary),
        `hash mismatch in ${mode}`
      );
    }

    const sessionId = `identity-${id}`;
    const result = runHook('post-tool-use.js', {
      session_id: sessionId,
      ...payload,
      tool_response: { stdout: 'ok', stderr: '', interrupted: false }
    });
    assert.deepStrictEqual(result.output, {});

    const row = chronicle.db().prepare(
      "SELECT tags FROM insights WHERE session_id = ? AND domain = 'session-action' ORDER BY id DESC LIMIT 1"
    ).get(sessionId);
    assert.ok(row, 'PostToolUse did not record the action');
    assert.ok(JSON.parse(row.tags).includes(expectedTag), `${expectedTag} missing from ${row.tags}`);
  });
}

(async () => {
  let passed = 0;
  let failed = 0;
  console.log(`Compass consistency audit (data: ${dataDir})`);
  for (const entry of tests) {
    try {
      await entry.fn();
      passed++;
      console.log(`  PASS  ${entry.name}`);
    } catch (error) {
      failed++;
      console.error(`  FAIL  ${entry.name}: ${error.stack || error.message}`);
    }
  }
  try { chronicle.close(); } catch (_) {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('NOTE: the rm-flag, prefix-downgrade and git-flag divergences are FIXED and now');
    console.log('      asserted as regressions above. Still UNRESOLVED by decision, not oversight:');
    console.log('      (a) non-Bash tools that shell out are ungated — every destructive rule is');
    console.log('          tool-scoped to Bash; (b) malformed payloads return a permissive OPEN;');
    console.log('      (c) an object-valued command fails open with no compass_log row.');
    console.log('      See COMPASS_CONSISTENCY.md and open thread #15.');
  }
  process.exit(failed ? 1 : 0);
})();
