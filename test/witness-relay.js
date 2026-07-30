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
// Nothing here executes an injection — the assertions are on the constructed
// argv, and the module is loaded in a child so that a resurrected top-level
// poll loop shows up as a hang, not as a pass.
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

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
