'use strict';

// A LINEAR matcher for the deploy-prod rule, semantically identical to the
// pattern that rule still declares.
//
// WHY THIS EXISTS. The declared pattern is quadratic in the number of trigger
// words in one separator-free segment:
//
//   \b(?:kubectl|…)\b (?!…segment-wide…) (?=…segment-wide…) […segment-wide…]prod
//
// Every occurrence of kubectl|terraform|helm|aws|gcloud re-runs three
// segment-wide scans, and the engine tries every occurrence before giving up.
// Measured on the integration tree, `kubectl apply x ` repeated:
//
//   150,000b -> 1,935ms   200,000b -> 3,494ms   400,000b -> hook killed at 5,000ms
//
// On fe8aa0c that cost was paid on Bash ONLY, because a rule whose `tool` said
// "Bash" was skipped for every other tool. Capability routing then started
// feeding the same rule the `command`/`script` of mcp__shell__run, Terminal and
// any future MCP shell tool — carriers fe8aa0c never gated at all — so an input
// that fe8aa0c cleared in ~55ms became a 2s NOT_EVALUATED deny at 150KB and a
// silent 5s kill at 400KB. The kill is the worst cell in the matrix: the call
// proceeds either way, but the audit row fe8aa0c wrote is lost.
//
// A budget cannot fix this. The whole cost is inside ONE uninterruptible
// `RegExp.prototype.test` call, so a check between rules never runs. The only
// defence is to make the rule cheap.
//
// WHY NOT A NARROWER PATTERN. test/compass-fail-closed.js names the reason this
// was left alone in the previous round: deploy-prod's read-only carve-out can
// block an EARLIER trigger that a later one does not, so the rewrite that made
// git-push-force and no-verify linear (refuse to scan across a later trigger)
// changes WHICH commands match here. `kubectl get pods x kubectl apply prod` is
// a WITNESS under the declared pattern and would stop being one. That objection
// stands; it is why this is an equivalence-proved reimplementation rather than a
// pattern edit. The proof obligation it named — "needs its own equivalence
// proof" — is discharged by test/compass-no-worse-than-base.js, which walks a
// generated corpus of this rule's own vocabulary and asserts the matcher and the
// declared pattern agree on every input, in both directions.
//
// THE SEMANTICS, restated exactly. The pattern matches iff there is a trigger
// occurrence p such that, looking only at the run of non-separator characters
// that starts where p ends:
//   • no read-only verb occurs in it that is also followed by whitespace or the
//     end of the whole string,
//   • at least one mutating verb occurs in it,
//   • at least one of prod|production occurs in it.
// All three are "does X occur at or after this point in the segment" questions,
// so per segment they collapse to three positions — the LAST read-only start,
// the LAST mutating start, the LAST target start — and every trigger in that
// segment is then answered in O(1). That is the whole algorithm.

// ── The vocabulary. One source for the matcher AND for the declared pattern ──
// buildPattern() below reconstructs the rule's `pattern` string from these lists
// character for character, and the suite asserts the reconstruction equals what
// lib/rules/compass-rules.json actually ships. So a vocabulary edit that reaches
// only one of the two is a test failure, not a silent divergence.
const TRIGGERS = ['kubectl', 'terraform', 'helm', 'aws', 'gcloud'];

const READ_ONLY = [
  'get', 'list', 'ls', 'describe', 'logs', 'top', 'explain', 'view', 'show',
  'status', 'cat', 'history', 'version', 'cluster-info', 'api-resources',
  'api-versions', 'get-contexts', 'current-context', 'whoami'
];

const MUTATING = [
  'apply', 'destroy', 'delete', 'create', 'deploy', 'replace', 'patch', 'scale',
  'rollout', 'install', 'upgrade', 'uninstall', 'terminate', 'update', 'put',
  'remove', 'rollback', 'drain', 'cordon', 'sync', 'edit', 'set', 'annotate',
  'label', 'restart', 'expose', 'taint', 'cp', 'mv', 'rm', 'run', 'start',
  'stop', 'import', 'invoke', 'unlock'
];

const TARGETS = ['prod', 'production'];

// The characters the pattern's `[^|;&\n\r]*` refuses to cross. A trigger and the
// words that qualify it must live in the same run between two of these.
const SEPARATORS = '|;&\n\r';

// Bumped whenever the vocabulary or the algorithm changes. Projected into
// compass_log's ruleset manifest, so a historical row names the matcher that
// decided it — the same reconstructability property `ruleset_hash` exists for.
const VERSION = 'deploy-prod-matcher/1.0.0';

/** The declared pattern, rebuilt from the lists above. */
function buildPattern() {
  const sep = '[^|;&\\n\\r]';
  return '(?i)' +
    `\\b(?:${TRIGGERS.join('|')})\\b` +
    `(?!${sep}*\\b(?:${READ_ONLY.join('|')})\\b(?=\\s|$))` +
    `(?=${sep}*\\b(?:${MUTATING.join('|')})\\b)` +
    `${sep}*\\b(?:${TARGETS.join('|')})\\b`;
}

// One scanner per vocabulary. None of these contains an unbounded quantifier, so
// each is a single left-to-right pass with O(1) work per position: this is where
// the linearity comes from, and it is why the scanners are built once at module
// load rather than per call.
const TRIGGER_RE = new RegExp(`\\b(?:${TRIGGERS.join('|')})\\b`, 'gi');
// `(?=\\s|$)` is carried over verbatim, including the fact that `$` means the end
// of the WHOLE string (the pattern has no `m` flag). It is not the end of the
// segment: `kubectl get|` is NOT suppressed, because `|` is neither whitespace
// nor the end of the string, while `kubectl get\n` IS, because `\n` is both a
// separator and whitespace. Scanning the full string rather than a segment slice
// is what keeps that — and every `\b` — evaluated in the same context the regex
// engine would have evaluated it in.
const READ_ONLY_RE = new RegExp(`\\b(?:${READ_ONLY.join('|')})\\b(?=\\s|$)`, 'gi');
const MUTATING_RE = new RegExp(`\\b(?:${MUTATING.join('|')})\\b`, 'gi');
const TARGET_RE = new RegExp(`\\b(?:${TARGETS.join('|')})\\b`, 'gi');

/**
 * Every start position where `re` matches, INCLUDING overlapping ones.
 *
 * lastIndex is advanced by one past the match START, not past its end. The
 * declared pattern is free to begin its read-only / mutating / target match at
 * any offset, so an occurrence that begins inside a longer one it already found
 * is a position the pattern can use. Advancing past the end would silently drop
 * those, and dropping a READ-ONLY occurrence widens the rule — an extra denial
 * on a command fe8aa0c cleared, which is exactly the direction this release may
 * not move in.
 */
function starts(re, s) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length });
    re.lastIndex = m.index + 1;
    if (re.lastIndex > s.length) break;
  }
  return out;
}

function isSeparator(ch) {
  return SEPARATORS.indexOf(ch) !== -1;
}

/**
 * @param {string} s
 * @returns {boolean} true iff the declared pattern would match `s`
 */
function test(s) {
  if (typeof s !== 'string' || s.length === 0) return false;

  const triggers = starts(TRIGGER_RE, s);
  if (!triggers.length) return false;
  const targets = starts(TARGET_RE, s);
  if (!targets.length) return false;
  const mutating = starts(MUTATING_RE, s);
  if (!mutating.length) return false;
  const readOnly = starts(READ_ONLY_RE, s);

  const n = s.length;
  // Walk the separator-free segments once, carrying a cursor into each
  // occurrence list. Every list is sorted by start, and segments are visited in
  // order, so the cursors only move forward: O(n + occurrences) in total.
  let ti = 0, mi = 0, gi = 0, ri = 0;
  let segStart = 0;
  while (segStart <= n) {
    let segEnd = segStart;
    while (segEnd < n && !isSeparator(s[segEnd])) segEnd++;

    if (segEnd > segStart) {
      // The LAST start of each kind inside [segStart, segEnd).
      let lastReadOnly = -1;
      while (ri < readOnly.length && readOnly[ri].start < segEnd) {
        if (readOnly[ri].start >= segStart) lastReadOnly = readOnly[ri].start;
        ri++;
      }
      let lastMutating = -1;
      while (mi < mutating.length && mutating[mi].start < segEnd) {
        if (mutating[mi].start >= segStart) lastMutating = mutating[mi].start;
        mi++;
      }
      let lastTarget = -1;
      while (gi < targets.length && targets[gi].start < segEnd) {
        if (targets[gi].start >= segStart) lastTarget = targets[gi].start;
        gi++;
      }

      // A trigger qualifies when the run after it still contains a mutating verb
      // and a target, and contains no read-only verb at all. `end` is the offset
      // the pattern's `[^|;&\n\r]*` starts from.
      const ceiling = Math.min(lastMutating, lastTarget);
      let hit = false;
      while (ti < triggers.length && triggers[ti].start < segEnd) {
        const end = triggers[ti].end;
        if (end <= segEnd && end > lastReadOnly && end <= ceiling) hit = true;
        ti++;
      }
      if (hit) return true;
    }

    segStart = segEnd + 1;
  }
  return false;
}

module.exports = {
  test,
  VERSION,
  buildPattern,
  TRIGGERS,
  READ_ONLY,
  MUTATING,
  TARGETS,
  SEPARATORS
};
