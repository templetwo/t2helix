'use strict';

// Single source of truth for credential patterns — imported by BOTH the compass
// rule loader (lib/compass.js, for the credential-paste classification) and the
// write-path scrubber (lib/chronicle.js, applied at record() / logCompass() /
// createPendingConfirmation()).
//
// DESIGN (v0.2, hardened after the security review): detection is DERIVED from
// the same pattern table that does the masking, so the two can never diverge.
// The v0.2.0 first cut kept a separate, broader DETECTION_REGEX than the
// redactors — which meant a command could be classified PAUSE ("a credential is
// here") while the redactor failed to mask it, persisting the secret in cleartext
// and re-injecting it via recall (the exact v0.1 leak). Here, anything the
// detector flags is, by construction, something a redactor will mask.
//
// AMENDED (secret-assign literal-value fix): "can never diverge" is now too
// strong, and the exact shape of the permitted divergence is the point. The
// invariant is DIRECTIONAL — DETECTION ⊆ REDACTION — not equality. A pattern may
// carry an optional `detectSrc` that is STRICTLY NARROWER than its `src`:
// REDACTORS always compile `src`, DETECTION_REGEX prefers `detectSrc`. That keeps
// the v0.2.0 leak closed (everything flagged is still maskable) while allowing
// the masker to stay WIDER than the gate, which is the correct asymmetry:
// over-masking a code expression costs nothing but a fingerprint in a chronicle
// row, whereas over-GATING it soft-denies a benign command and trains the seat to
// approve credential warnings reflexively. Only `secret-assign` uses it; widening
// `detectSrc` beyond its `src` would reopen the v0.1 leak and is forbidden.
//
// Each pattern masks the secret span with a fingerprint —
// `[REDACTED:<kind>:<8-hex of sha256(secret)>]` — keeping entries diagnosable and
// linkable without storing the value. `group: 0` masks the whole match (the match
// IS the secret); `group > 0` masks only that capture group, preserving the label.

const crypto = require('crypto');

function fingerprint(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 8);
}

// A VALUE THAT IS CODE, not a credential. Used only by the DETECTION side (see
// `detectSrc` below), never by a redactor.
//
// Two arms, and both are needed:
//
//   [$[({<`]                       an opening sigil — `$VAR`, `${VAR}`, `$(cmd)`,
//                                  `` `cmd` ``, `[expr]`, `[regex]`, `{json}`,
//                                  `(expr)`, `<<HEREDOC`. Everything a shell or a
//                                  language uses to say "evaluate this".
//   [A-Za-z_][A-Za-z0-9_.]{0,63}[(\[]   a bare or dotted identifier followed by a
//                                  CALL or a SUBSCRIPT — `getpass()`,
//                                  `os.environ["X"]`, `os.path.expanduser(…)`.
//
// The second arm requires the `(` or `[`. It deliberately does NOT stop at a bare
// dotted identifier, because `header.payload.signature` is also the shape of a
// JWT: excluding dotted runs outright would lose `token=eyJ….eyJ….sig`, a real
// secret with no other leg to catch it. The cost of that choice is recorded as
// accepted residue in test/fixtures/secret-assign-vectors.js rather than claimed
// to be zero.
//
// LINEARITY. The ident run is BOUNDED at 64 and its terminator `[(\[]` is
// disjoint from the run's own class, so a start position costs at most 65 steps
// with no backtracking ambiguity — the property this file's url-auth note spent
// 40 lines earning the hard way. This is a lookahead at a single anchored
// position, not a scanning pattern.
const EXPRESSION_VALUE = '(?:[$\\[({<`]|[A-Za-z_][A-Za-z0-9_.]{0,63}[(\\[])';

// One table → REDACTORS (masking) and DETECTION_REGEX (classification). `src` is
// a flagless source string; `group` is the capture index of the secret value.
// `detectSrc`, when present, replaces `src` for DETECTION ONLY and must be a
// strict narrowing of it (see the directional invariant in the header).
// Ordered most-specific/greedy first so a broad pattern claims its span before a
// narrower one runs on the already-redacted string.
const PATTERNS = [
  // PEM private key block — whole block; tolerate a missing END when truncated.
  { kind: 'private-key', group: 0,
    src: '-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\\s\\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----|$)' },
  // URL userinfo password — scheme://user:PASS@host. Mask the password span.
  //
  // ── WHY THIS IS ANCHORED ON THE LITERAL `://` ───────────────────────────────
  //
  // Written the obvious way, `[a-z][a-z0-9+.-]*://…`, this pattern is QUADRATIC
  // on a long unbroken run of scheme-class characters: the engine starts a match
  // at every position in the run and each attempt scans to the end of the run
  // looking for a `://` that is not there. Measured on `echo ` + 100,000 a's:
  // 4,772ms; at 200,000: 17,683ms — and on fe8aa0c, 73,316ms at 200,000.
  //
  // A `(?<![a-z])` scheme-start lookbehind was added first. It fixes the
  // LETTERS-ONLY case (after the first letter of a run, every start is rejected
  // because the preceding character is itself a scheme letter) and it is why an
  // 'a'.repeat(n) pad measures ~2ms. It does NOT fix a run containing DIGITS: a
  // digit is not `[a-z]`, so every position FOLLOWING a digit passes the
  // lookbehind and starts a fresh scan to the end of the run. In a random
  // letter+digit run that is ~n/2 restarts x O(n) work each — still quadratic.
  // Measured at 200,000 chars with only the lookbehind in place:
  //
  //     hex [0-9a-f] 4,387ms   [a-z0-9] 3,627ms   [A-Za-z0-9] 2,234ms
  //     base64url 4.4ms   base64 std 4.3ms   letters-only 2.2ms   'a'*n 1.5ms
  //
  // base64 is fast for a DIFFERENT reason: `/` and `_` are outside the scheme
  // class, so they break the run every few characters. Only a letter+digit run
  // defeats both effects at once — and hex dumps (`openssl rand -hex`,
  // concatenated sha256s, `xxd -p`) and alphanumeric ID streams are ordinary
  // shell payloads, not adversarial ones. Because the credential rule is now
  // capability-routed, that cost reached `mcp__shell__run`, `Terminal` and the
  // Grok envelope, which fe8aa0c waved through in ~58ms: at 400KB an ALLOW
  // became a 2,620ms DENY, and at 800KB a 5,004ms SIGKILL that emitted nothing
  // and LOST the audit row fe8aa0c had written.
  //
  // THE FIX. Lead with the literal `://` and verify the scheme BEHIND it. The
  // engine can now reject every position that is not a `:` in O(1), so the
  // number of match attempts that do real work is the number of `://`
  // occurrences rather than the number of digits. Same three shapes at 200,000:
  // 4,387ms -> 0.6ms, 3,627ms -> 1.2ms, 2,234ms -> 1.2ms; at 400,000, 15,949ms
  // -> 1.2ms.
  //
  // THE COST THIS TRADES FOR is a BACKWARD scan inside the lookbehind, paid once
  // per `://` occurrence. The mechanism that keeps it cheap is that `/` is not in
  // `[a-z0-9+.-]`, so a `://` terminates the very scheme run a following `://`
  // would need to scan back through. That is the mechanism, not a proof: what is
  // MEASURED is that no shape probed exceeded 2.5ms at 400,000 chars, including
  // ones built to be adversarial to this form specifically — a long run kept
  // class-legal by `.`/`-`/`+` then many `://` (2,085ms and 8,405ms on the OLD
  // form at 200K/400K, 0.7ms and 1.4ms here), repeated `'a'x200 + '://'` pairs,
  // and digit- and punctuation-only runs followed by many `://`. If a shape is
  // ever found that defeats this, it is a bug in the pattern, not in the note.
  //
  // EQUIVALENCE — the constraint that governs this pattern. This table does
  // DOUBLE DUTY: DETECTION_REGEX classifies for the compass credential-paste
  // rule, and the SAME `src` compiles into REDACTORS, which is what actually
  // masks secrets on the chronicle write path. A detection change that silently
  // stopped masking would be worse than the stall it fixed. So equivalence was
  // proved on CAPTURE GROUPS and on redactor OUTPUT, not on test() hit/miss:
  // 4,489,568 inputs (a 4.0M structured cross-product over every part of the
  // grammar, 53 named adversarial cases, exhaustive enumeration of every string
  // of length <= 5 over `a1:/@.Z`, 400K randomised fuzz, 60K strings carrying
  // 2-12 url-auth spans each, and 84 inputs of 10K-100K chars) with ZERO
  // divergences in DETECTION_REGEX.test(), in group-1 span VALUE AND INDEX, in
  // redactSecrets() and in scrub(). The harness was negative-controlled: the
  // naive alternative below is rejected by it with 74,564 divergences.
  //
  // The form uses a VARIABLE-LENGTH lookbehind containing a NESTED negative
  // lookbehind, so equivalence was re-proved at the FLOOR of the declared engine
  // range (package.json `>=20 <27`): node v20.19.6 returns the same 4,489,568
  // inputs / 0 divergences as v26.0.0.
  //
  // NOTE match[0] IS shorter now — it no longer covers the scheme. That is safe
  // and does not change redaction output because `group: 1` masking re-emits
  // everything outside group 1 verbatim, so the scheme is simply left untouched
  // in the source string instead of being consumed and re-emitted.
  //
  // DO NOT "simplify" this to `(?<![a-z0-9+.-])[a-z]…`. Widening the lookbehind
  // to the whole scheme class looks like the same idea and LOSES DETECTIONS:
  // `1abc://u:pass@h` matches today (the scheme starts at `a`, preceded by `1`)
  // and would stop matching, because no start position survives. That is a
  // secret that stops being masked.
  { kind: 'url-auth', group: 1,
    src: '://(?<=(?<![a-z])[a-z][a-z0-9+.-]*://)[^/\\s:@]+:([^/\\s@]{3,})@' },
  // HTTP Basic auth header — base64 blob after "Basic".
  { kind: 'basic-auth', group: 1,
    src: 'authorization\\s*:\\s*basic\\s+([A-Za-z0-9+/=]{8,})' },
  // Bearer token (with or without the Authorization: header). Floor 8 so short
  // opaque tokens are caught (the detector had no floor; aligning them).
  { kind: 'bearer', group: 1,
    src: '(?:authorization\\s*:\\s*)?bearer\\s+([A-Za-z0-9._\\-+/=]{8,})' },
  // Bearer fragment left straddling summarizeAction's 200-char cut (…/...): mask
  // any surviving prefix regardless of length so a truncated token can't leak.
  { kind: 'bearer-trunc', group: 1,
    src: 'bearer\\s+([A-Za-z0-9._\\-+/=]+)(?=\\u2026|\\.\\.\\.\\s*$)' },
  // Stripe secret / restricted keys (note the UNDERSCORE — distinct from sk-).
  { kind: 'stripe-key', group: 0, src: '\\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}' },
  // Anthropic / OpenAI style sk- keys (hyphen).
  { kind: 'sk-key', group: 0, src: '\\bsk-[A-Za-z0-9_-]{16,}' },
  // GitHub personal-access / app tokens.
  { kind: 'github-token', group: 0,
    src: '\\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\\b|\\bgithub_pat_[A-Za-z0-9_]{20,}\\b' },
  // Google API key (canonical length 35; tolerant floor avoids brittle exact match).
  { kind: 'google-key', group: 0, src: '\\bAIza[0-9A-Za-z_-]{30,}' },
  // Slack tokens.
  { kind: 'slack-token', group: 0, src: '\\bxox[baprs]-[A-Za-z0-9-]{10,}' },
  // npm tokens.
  { kind: 'npm-token', group: 0, src: '\\bnpm_[A-Za-z0-9]{36}\\b' },
  // SendGrid keys.
  { kind: 'sendgrid-key', group: 0, src: '\\bSG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}' },
  // AWS access key id.
  { kind: 'aws-akid', group: 0, src: '\\bAKIA[0-9A-Z]{16}\\b' },
  // Labelled secret assignment — covers `key=value`, `key: value`, and JSON
  // `"key":"value"` (the optional quote between key and separator). The leading
  // lookbehind lets the keyword sit after `_`/start/space (DB_PASSWORD,
  // AWS_SECRET_ACCESS_KEY) but not after a letter/digit (so `mypassword` is not a
  // key). The `(?![A-Za-z])` right after the keyword stops `tokenizer`/`tokens`/
  // `secretariat` from matching via `token`/`secret`. The value class is wide
  // (any non-space/quote/comma/brace run, floor 8) so passwords with special
  // chars (@!#$%) are masked, and `(?!\[REDACTED)` keeps a re-scrub idempotent.
  //
  // ── WHY DETECTION IS NARROWER THAN MASKING FOR THIS LEG ────────────────────
  //
  // `src` above fires on ANY labelled assignment with an 8+ character value. It
  // never asks what the value IS. That is right for MASKING — a chronicle row
  // should not carry `token=<anything>` in cleartext — and wrong for GATING,
  // because the overwhelmingly common labelled assignment on a real command line
  // is one whose value is CODE:
  //
  //     token=[l.split("=",1)[1].strip() for l in open(...) if ...][0]
  //     token=$(cat ~/.config/x.env)      TOKEN="$BRIDGE_TOKEN"
  //     api_key: os.environ["X"]          password = getpass()
  //
  // Measured on the HQ seat over seven days of compass_log: 52 PAUSE and 24
  // confirmed-OPEN on `credential-paste` across four sessions, dominated by that
  // shape. The specimen that forced this change READS the bridge env file — it
  // pastes nothing — and was soft-denied repeatedly. That is not a harmless
  // over-warning: every PAUSE mints a single-use confirm token, so a gate that
  // cries wolf on ordinary code teaches the seat to spend those tokens without
  // reading, which is precisely the reflex the credential gate exists to prevent.
  //
  // `detectSrc` therefore adds ONE thing to `src`: a negative lookahead at the
  // value position rejecting EXPRESSION_VALUE. Everything else is byte-identical
  // — same keyword set, same lookbehind, same `(?![A-Za-z])` guard, same
  // `[^\s"',}]` value class, SAME 8-CHARACTER FLOOR.
  //
  // The floor and the value class were deliberately left alone. Raising the floor
  // to 16 and restricting the value to a token charset both LOSE true positives
  // this repo already asserts: `password=hunter2hunter2` (14 chars) is a
  // must-PAUSE adversarial seed in test/compass-fail-closed.js, `api_key=abcdefghij`
  // (10) is asserted PAUSE there too, and test/smoke.js asserts detection of
  // `password=P@ssw0rd!Sup3r#SecretValue`, whose token-charset prefix is one
  // character long. The release rule is "strictly no worse than base on every
  // carrier" (COMPASS_CONSISTENCY.md), so the expression lookahead does the whole
  // job on its own — it retires the false positives without touching the
  // threshold that catches short literal passwords.
  { kind: 'secret-assign', group: 1,
    src: '(?<![A-Za-z0-9])(?:password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token)(?![A-Za-z])[A-Za-z0-9_]*["\']?\\s*[:=]\\s*["\']?((?!\\[REDACTED)[^\\s"\',}]{8,})',
    detectSrc: '(?<![A-Za-z0-9])(?:password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token)(?![A-Za-z])[A-Za-z0-9_]*["\']?\\s*[:=]\\s*["\']?(?!\\[REDACTED)(?!' + EXPRESSION_VALUE + ')[^\\s"\',}]{8,}' }
];

const REDACTORS = PATTERNS.map(p => ({ kind: p.kind, group: p.group, re: new RegExp(p.src, 'gi') }));

// Detection = the redactor patterns (so any credential VALUE that is flagged is
// also maskable — closing the v0.2.0 detect-but-don't-mask leak) PLUS a few bare
// credential KEY-NAMES for an advisory PAUSE on credential-shaped commands even
// when no high-entropy value is present in that command. Name-only matches carry
// nothing to mask, so they cannot leak a value; they only widen the soft warning.
//
// The trailing lookahead is the name-only half of the same literal-value fix, and
// it is REQUIRED for it: `api_key: os.environ["X"]` matches `\bapi[_-]?key\b` on
// the KEY NAME alone, so narrowing only the secret-assign leg would leave that
// command soft-denied by this one instead. The division of labour is now clean —
// a credential key-name mentioned with NO value stays an advisory PAUSE
// (`echo $api_key`, `cat ~/.aws/secret_access_key`), and a key-name that IS in
// assignment position defers to the value: literal → PAUSE, expression → OPEN.
//
// Note the wrapping `(?: … )`. These are three top-level alternatives spliced
// with `|`; without the group the lookahead would bind to the last alternative
// only and silently leave `aws_secret` and `secret_access_key` unnarrowed.
//
// This DOES give up one case that base flagged: `AWS_SECRET_ACCESS_KEY=$(vault
// read …)` was PAUSE on the name alone and is OPEN now. Reading from a secret
// store is not pasting a credential. The loss is deliberate and is asserted, as a
// loss, in test/secret-assign-literal.js so it cannot be mistaken for drift.
const NAME_ONLY_DETECT =
  '(?:\\baws_secret\\b|secret[_-]?access[_-]?key|\\bapi[_-]?key\\b)'
  + '(?!["\']?\\s*[:=]\\s*["\']?' + EXPRESSION_VALUE + ')';

// `detectSrc` wins for detection where a pattern defines one; REDACTORS above
// always compile `src`. This is the one place the two sides are allowed to
// differ, and only in the direction detection ⊆ redaction.
const DETECTION_REGEX = new RegExp(
  PATTERNS.map(p => `(?:${p.detectSrc || p.src})`).join('|') + '|' + NAME_ONLY_DETECT,
  'i'
);

function looksLikeSecret(text) {
  if (text == null) return false;
  return DETECTION_REGEX.test(String(text));
}

// Mask every secret span in `text`, leaving everything else intact. Returns the
// input unchanged (same null/undefined semantics) when there is nothing to mask.
function redactSecrets(text) {
  if (text == null) return text;
  let s = String(text);
  for (const { kind, re, group } of REDACTORS) {
    s = s.replace(re, (match, ...rest) => {
      const secret = group > 0 ? rest[group - 1] : match;
      if (secret == null || secret === '') return match;
      const token = `[REDACTED:${kind}:${fingerprint(secret)}]`;
      if (group === 0) return token;
      const idx = match.lastIndexOf(secret);
      if (idx < 0) return token;
      return match.slice(0, idx) + token + match.slice(idx + secret.length);
    });
  }
  return s;
}

// The write-path chokepoint. redactSecrets() masks known spans; the fixed-point
// backstop guarantees the OUTPUT contains no maskable secret — if a second pass
// would still change the string (a pattern matched but its span wasn't fully
// masked), coarse-mask the whole field rather than persist a residual secret.
// This is the "never persist a detected secret raw" invariant the chronicle
// relies on. Designed not to throw on normal input; callers still treat a throw
// as redact-or-drop (the one inverted fail-open path).
function scrub(text) {
  if (text == null) return text;
  const once = redactSecrets(text);
  if (redactSecrets(once) === once) return once; // fixed point — fully masked
  return `[REDACTED:residual:${fingerprint(String(text))}]`;
}

module.exports = {
  fingerprint,
  redactSecrets,
  scrub,
  looksLikeSecret,
  DETECTION_REGEX,
  REDACTORS,
  PATTERNS
};
