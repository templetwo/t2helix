'use strict';

// test/witness-relay.js — the workflow-memory monitor must reach the relay host
// through an argv array, never through a shell.
//
// JETSON_USER / JETSON_HOST are operator-supplied. Interpolated into a string
// handed to child_process.exec they are a command-injection surface; and even
// with no shell, a value starting with "-" lands in argv[0] where ssh parses it
// as an option (-oProxyCommand=...), which is the same hole one layer down. So
// the argv builder is asserted directly: shape, fixed remote command, and hard
// rejection of anything that is not a plain user/host name.
//
// Legs 1-6 assert the argv BUILDER in isolation. That is not enough on its own:
// an adversarial review proved that sshArgv() can stay byte-perfect while the
// CALL SITE is rebuilt around a shell, and legs 1-6 all stay green while an
// injection fires. So legs 7-9 run the monitor as a REAL PROCESS (require.main,
// the actual entry path) and assert the properties the builder cannot:
//   7/8  a hostile env stops it at startup — benign marker never created, exit
//        status 2, stderr names the offending variable;
//   9    under BENIGN env the call site invokes execFile('ssh', sshArgv()) and
//        nothing else — pinned by stubbing child_process in a --require preload.
// Leg 7/8's marker assertion is a positive control: on a mutant that restores
// the vulnerability the marker MUST appear, otherwise the assertion is inert.
//
// The only payload ever executed is `touch <marker>` inside this test's own
// mkdtemp directory. Nothing destructive is run.
//
// Run: node test/witness-relay.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2helix-relay-'));
const MODULE = path.join(__dirname, '..', 'tools', 'witness-relay', 'monitor_workflow_memory.js');
const REMOTE_CMD = 'cat ~/witness_relay/workflow_memory.jsonl';

// Load the module in a child and print what sshArgv() builds for the given env.
// spawnSync's timeout turns "requiring the module starts a poll loop" into a
// visible failure instead of a hung suite.
function argvFor(env) {
  const snippet = `
    const m = require(${JSON.stringify(MODULE)});
    try { process.stdout.write(JSON.stringify({ argv: m.sshArgv() })); }
    catch (e) { process.stdout.write(JSON.stringify({ error: e.message })); }
  `;
  const res = spawnSync(process.execPath, ['-e', snippet], {
    encoding: 'utf8',
    timeout: 8000,
    env: { ...process.env, T2HELIX_DATA_DIR: tmpDir, ...env }
  });
  if (res.signal) throw new Error(`child killed (${res.signal}) — module has top-level side effects`);
  let out;
  try { out = JSON.parse(res.stdout); }
  catch { throw new Error(`no argv on stdout (exit ${res.status}): ${res.stdout}${res.stderr}`); }
  return out;
}

// Run the monitor AS require.main — the real entry path, guard and call site
// both live. Both relay vars are always pinned explicitly so an ambient
// JETSON_USER/JETSON_HOST on the host machine cannot change which variable the
// error names (that would make the assertion read the wrong thing).
const GOOD = { JETSON_USER: 'relay-user', JETSON_HOST: 'relay.example.net' };
function runMonitor(env, extraArgv = []) {
  return spawnSync(process.execPath, [...extraArgv, MODULE], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, T2HELIX_DATA_DIR: tmpDir, TMPDIR: tmpDir, ...GOOD, ...env }
  });
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}

test('defaults build a two-element argv with a fixed remote command', () => {
  const r = argvFor({ JETSON_USER: '', JETSON_HOST: '' });
  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.deepStrictEqual(r.argv, ['jetson@jetson.local', REMOTE_CMD]);
});

test('legitimate user/host land in argv[0] only, remote command untouched', () => {
  const r = argvFor({ JETSON_USER: 'relay-user', JETSON_HOST: 'relay.example.net' });
  assert.ok(!r.error, `unexpected error: ${r.error}`);
  assert.deepStrictEqual(r.argv, ['relay-user@relay.example.net', REMOTE_CMD]);
});

test('a metacharacter-carrying JETSON_HOST is refused, not passed on', () => {
  const r = argvFor({ JETSON_HOST: 'relay.local; touch /tmp/t2helix-pwned' });
  assert.ok(r.error, 'shell metacharacters in JETSON_HOST must be refused');
  assert.ok(/JETSON_HOST/.test(r.error), `error must name the offending variable: ${r.error}`);
});

test('command substitution in JETSON_USER is refused', () => {
  const r = argvFor({ JETSON_USER: 'jetson$(id)' });
  assert.ok(r.error, 'command substitution in JETSON_USER must be refused');
  assert.ok(/JETSON_USER/.test(r.error), `error must name the offending variable: ${r.error}`);
});

test('a leading dash is refused — argv[0] must not be parsed as an ssh option', () => {
  const r = argvFor({ JETSON_USER: '-oProxyCommand=whoami' });
  assert.ok(r.error, 'a value starting with "-" must be refused');
});

test('no shell is spawned: execFile with argv, no exec()', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  assert.ok(/execFile\(/.test(src), 'the monitor must call execFile');
  assert.ok(!/(^|[^A-Za-z.])exec\(/m.test(src), 'child_process.exec spawns a shell — use execFile');
  assert.ok(!/`ssh /.test(src), 'the ssh invocation must not be built as a template string');
});

// ── Call site + startup guard, exercised as a real process ───────────────────
// These are the legs that survive a byte-perfect sshArgv(). tmpDir must still
// exist here: the marker assertion is only meaningful if `touch` COULD have
// written, so the cleanup below runs after all legs, never before.

test('running the monitor with a hostile JETSON_HOST fires no shell (exit 2, names the var)', () => {
  const marker = path.join(tmpDir, 'INJECTION_FIRED_HOST');
  assert.ok(!fs.existsSync(marker), 'marker must not pre-exist');
  const r = runMonitor({ JETSON_HOST: `nonexistent.invalid; touch ${marker} #` });
  assert.ok(fs.existsSync(tmpDir), 'tmpDir must exist — otherwise the marker check is inert');
  assert.ok(!fs.existsSync(marker), 'a shell executed the injected command — the call site still reaches a shell');
  assert.strictEqual(r.status, 2, `expected exit 2, got status=${r.status} signal=${r.signal}: ${r.stderr}`);
  assert.match(r.stderr || '', /JETSON_HOST/, `error must name the offending variable: ${r.stderr}`);
});

test('running the monitor with command substitution in JETSON_USER fires no shell', () => {
  const marker = path.join(tmpDir, 'INJECTION_FIRED_USER');
  assert.ok(!fs.existsSync(marker), 'marker must not pre-exist');
  const r = runMonitor({ JETSON_USER: `jetson$(touch ${marker})` });
  assert.ok(fs.existsSync(tmpDir), 'tmpDir must exist — otherwise the marker check is inert');
  assert.ok(!fs.existsSync(marker), 'a shell executed the injected command');
  assert.strictEqual(r.status, 2, `expected exit 2, got status=${r.status} signal=${r.signal}: ${r.stderr}`);
  assert.match(r.stderr || '', /JETSON_USER/, `error must name the offending variable: ${r.stderr}`);
});

test('under benign env the call site invokes execFile("ssh", sshArgv()) — no shell binary', () => {
  // Preload stubs BOTH child_process.exec and .execFile, records which one the
  // monitor reached and with what argv, then exits. The monitor destructures
  // execFile at require time, i.e. after this preload has run.
  const capture = path.join(tmpDir, 'callsite.json');
  const preload = path.join(tmpDir, 'capture-preload.js');
  fs.writeFileSync(preload, `
    const cp = require('child_process');
    const fs = require('fs');
    for (const fn of ['exec', 'execFile']) {
      cp[fn] = function (file, args) {
        fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ fn, file, args }));
        process.exit(0);
      };
    }
  `);

  const r = runMonitor({}, ['--require', preload]);
  assert.ok(
    fs.existsSync(capture),
    `the call site invoked neither exec nor execFile (status=${r.status} signal=${r.signal}): ${r.stderr}`
  );
  const got = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.strictEqual(got.fn, 'execFile', `call site used child_process.${got.fn} — exec spawns a shell`);
  assert.strictEqual(got.file, 'ssh', `call site must exec ssh directly, got ${JSON.stringify(got.file)}`);
  assert.deepStrictEqual(
    got.args,
    [`${GOOD.JETSON_USER}@${GOOD.JETSON_HOST}`, REMOTE_CMD],
    'call site argv must be exactly what sshArgv() builds'
  );
});

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
