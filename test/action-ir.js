'use strict';

// test/action-ir.js — Action IR parser + hash stability (Compass V2 / v0.12)

const assert = require('assert');
const { parseToIR, canonicalizeAction, PARSER_VERSION } = require('../lib/action-ir');
const { parseBashCommand, tokenizeConservative } = require('../lib/action-ir/bash');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

console.log('action-ir');

test('parser_version is action-ir/0.12.0', () => {
  assert.strictEqual(PARSER_VERSION, 'action-ir/0.12.0');
  const ir = parseToIR('Bash', { command: 'ls' });
  assert.strictEqual(ir.parser_version, PARSER_VERSION);
});

test('tokenizes simple command', () => {
  const { tokens } = tokenizeConservative('rm -f file.txt');
  const words = tokens.filter(t => t.kind === 'word').map(t => t.value);
  assert.deepStrictEqual(words, ['rm', '-f', 'file.txt']);
});

test('splits on && and pipes', () => {
  const parsed = parseBashCommand('ls /tmp && rm -f a.txt | wc -l');
  assert.ok(parsed.segments.length >= 2);
  assert.strictEqual(parsed.segments[0].executable, 'ls');
});

test('detects wildcard operands on rm', () => {
  const ir = parseToIR('Bash', { command: 'rm -f ./tui_1d.svg*' });
  assert.strictEqual(ir.segments[0].executable, 'rm');
  assert.ok(ir.segments[0].wildcard_operands.length >= 1);
  assert.ok(ir.mutation_targets.some(t => t.includes('tui_1d')));
});

test('preserves quoted strings as quoted', () => {
  const { tokens } = tokenizeConservative('echo "rm -rf /"');
  const q = tokens.find(t => t.quoted);
  assert.ok(q);
  assert.ok(q.value.includes('rm -rf'));
});

test('bash -c nests interpreter boundary', () => {
  const ir = parseToIR('Bash', { command: "bash -c 'rm -rf /tmp/x/*'" });
  const seg = ir.segments[0];
  assert.ok(seg.interpreter_boundary);
  assert.strictEqual(seg.interpreter_boundary.kind, 'shell-c');
  assert.ok(
    (seg.interpreter_boundary.nested_segments || []).some(s => s.executable === 'rm') ||
    (seg.uncertainty || []).some(u => u.executable === 'rm' || u.code === 'nested-executable')
  );
});

test('hash stable across double spaces', () => {
  const a = parseToIR('Bash', { command: 'rm -f file.txt' });
  const b = parseToIR('Bash', { command: 'rm  -f  file.txt' });
  // Tokenization collapses whitespace between words → same canonical argv
  assert.strictEqual(a.normalized_action_hash, b.normalized_action_hash);
});

test('hash changes when argv changes', () => {
  const a = parseToIR('Bash', { command: 'rm -f a.txt' });
  const b = parseToIR('Bash', { command: 'rm -f b.txt' });
  assert.notStrictEqual(a.normalized_action_hash, b.normalized_action_hash);
});

test('Edit adapter uses structured path', () => {
  const ir = parseToIR('Edit', { file_path: '/repo/lib/x.js', old_string: 'a', new_string: 'b' });
  assert.strictEqual(ir.segments[0].structured.file_path, '/repo/lib/x.js');
  assert.deepStrictEqual(ir.mutation_targets, ['/repo/lib/x.js']);
});

test('canonical includes parser_version', () => {
  const ir = parseToIR('Bash', { command: 'true' });
  const c = canonicalizeAction(ir);
  assert.strictEqual(c.parser_version, PARSER_VERSION);
});

test('heredoc-ish and operators do not throw', () => {
  const ir = parseToIR('Bash', {
    command: 'cat <<EOF\nrm -rf /\nEOF\n'
  });
  assert.ok(ir.normalized_action_hash);
  assert.ok(Array.isArray(ir.uncertainty));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
