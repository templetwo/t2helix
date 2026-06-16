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
// Each pattern masks the secret span with a fingerprint —
// `[REDACTED:<kind>:<8-hex of sha256(secret)>]` — keeping entries diagnosable and
// linkable without storing the value. `group: 0` masks the whole match (the match
// IS the secret); `group > 0` masks only that capture group, preserving the label.

const crypto = require('crypto');

function fingerprint(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 8);
}

// One table → REDACTORS (masking) and DETECTION_REGEX (classification). `src` is
// a flagless source string; `group` is the capture index of the secret value.
// Ordered most-specific/greedy first so a broad pattern claims its span before a
// narrower one runs on the already-redacted string.
const PATTERNS = [
  // PEM private key block — whole block; tolerate a missing END when truncated.
  { kind: 'private-key', group: 0,
    src: '-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\\s\\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----|$)' },
  // URL userinfo password — scheme://user:PASS@host. Mask the password span.
  { kind: 'url-auth', group: 1,
    src: '[a-z][a-z0-9+.-]*://[^/\\s:@]+:([^/\\s@]{3,})@' },
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
  { kind: 'secret-assign', group: 1,
    src: '(?<![A-Za-z0-9])(?:password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token)(?![A-Za-z])[A-Za-z0-9_]*["\']?\\s*[:=]\\s*["\']?((?!\\[REDACTED)[^\\s"\',}]{8,})' }
];

const REDACTORS = PATTERNS.map(p => ({ kind: p.kind, group: p.group, re: new RegExp(p.src, 'gi') }));

// Detection = the redactor patterns (so any credential VALUE that is flagged is
// also maskable — closing the v0.2.0 detect-but-don't-mask leak) PLUS a few bare
// credential KEY-NAMES for an advisory PAUSE on credential-shaped commands even
// when no high-entropy value is present in that command. Name-only matches carry
// nothing to mask, so they cannot leak a value; they only widen the soft warning.
const NAME_ONLY_DETECT = '\\baws_secret\\b|secret[_-]?access[_-]?key|\\bapi[_-]?key\\b';
const DETECTION_REGEX = new RegExp(
  PATTERNS.map(p => `(?:${p.src})`).join('|') + '|' + NAME_ONLY_DETECT,
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
