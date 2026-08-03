'use strict';

// APERIODIC PADS — the shape both cost suites were structurally blind to.
//
// WHY THIS EXISTS. Every pad the two cost suites built before 2026-07-30 was
// PERIODIC: test/compass-fail-closed.js padShapes() repeats the rule's own
// trigger or `'a'.repeat(n)`, and test/compass-no-worse-than-base.js's
// BENIGN_SHAPES repeat a 52-char base64 token and a 26-char lowercase cycle.
// A periodic pad measures ~2ms against lib/secrets.DETECTION_REGEX at 200,000
// characters. An APERIODIC one mixing LETTERS AND DIGITS measured 2,276-4,095ms
// against the same regex at the same size — so the "420 cells, 0 worse" receipt
// was accurate for the shapes it swept and blind to the shape that mattered. An
// independent 630-cell grid then found five cells where the merged tree was
// WORSE than fe8aa0c, all of them `b64-random` (a letter+digit run), four of
// them a 5,004ms SIGKILL that emitted nothing and LOST the audit row fe8aa0c
// had written.
//
// The determinant is not entropy and not length. It is: letters AND digits in
// one unbroken aperiodic run. Measured at 200,000 chars on the pre-fix tree —
//
//   hex [0-9a-f]      4,268ms       base64url        4.4ms
//   HEX [0-9A-F]      4,089ms       base64 std       4.3ms
//   [a-z0-9]          3,627ms       letters only     2.2ms
//   [A-Za-z0-9]       2,394ms       'a'.repeat(n)    1.5ms
//
// base64 is fast because `/` and `_` are outside the scheme class
// `[a-z0-9+.-]`, so they break the run; letters-only is fast because the
// pattern's `(?<![a-z])` anchor then rejects every start but the first. Only a
// letter+digit run defeats both: each digit is a fresh restart point for a
// scan that runs to the end of the run. Realistic sources are ordinary — hex
// dumps (`openssl rand -hex`, concatenated sha256s, `xxd -p`) and alphanumeric
// ID/token streams.
//
// DETERMINISM IS A REQUIREMENT, NOT A CONVENIENCE. A perf assertion that
// occasionally draws a fast pad is worse than no assertion. The keystream is
// sha256 in counter mode, chunked in fixed 4,096-byte epochs so a pad of size
// n is a strict PREFIX of a pad of any larger size — one no-match check at the
// largest size therefore covers every smaller one.
//
// It is deliberately NOT a linear congruential generator. The first cut of the
// probe that found this bug used an LCG, whose low-order bits have a short
// period modulo a power-of-two alphabet: it silently produced a PERIODIC "hex"
// pad that measured 1.8ms and reported the bug as absent. The generator was the
// instrument, and the instrument was the first thing wrong.

const crypto = require('crypto');

const EPOCH_BYTES = 4096;

const ALPHABETS = {
  hex: '0123456789abcdef',
  HEX: '0123456789ABCDEF',
  alnum36: 'abcdefghijklmnopqrstuvwxyz0123456789',
  alnum62: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  letters: 'abcdefghijklmnopqrstuvwxyz'
};

function epochBytes(seed, epoch) {
  const buf = Buffer.alloc(EPOCH_BYTES);
  let off = 0, ctr = 0;
  while (off < EPOCH_BYTES) {
    const blk = crypto.createHash('sha256').update(`${seed}#${epoch}:${ctr++}`).digest();
    blk.copy(buf, off, 0, Math.min(blk.length, EPOCH_BYTES - off));
    off += blk.length;
  }
  return buf;
}

/**
 * A deterministic, prefix-stable, aperiodic run of `n` characters drawn
 * uniformly from `alpha` by REJECTION sampling (no modulo bias, which is what
 * reintroduces short-period structure on a power-of-two alphabet).
 */
function aperiodic(alpha, n, seed) {
  const lim = Math.floor(256 / alpha.length) * alpha.length;
  const parts = [];
  let len = 0, epoch = 0;
  while (len < n) {
    const buf = epochBytes(seed, epoch++);
    let chunk = '';
    for (let i = 0; i < buf.length && len + chunk.length < n; i++) {
      if (buf[i] >= lim) continue;
      chunk += alpha[buf[i] % alpha.length];
    }
    parts.push(chunk);
    len += chunk.length;
  }
  return parts.join('');
}

const hexRun = (n, seed) => aperiodic(ALPHABETS.hex, n, seed || 'hex-run/v1');
const alnum36Run = (n, seed) => aperiodic(ALPHABETS.alnum36, n, seed || 'alnum36-run/v1');
const alnum62Run = (n, seed) => aperiodic(ALPHABETS.alnum62, n, seed || 'alnum62-run/v1');

module.exports = { ALPHABETS, aperiodic, hexRun, alnum36Run, alnum62Run, EPOCH_BYTES };
