'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const secrets = require('./secrets');

const BUNDLED_RULES = path.join(__dirname, 'rules', 'compass-rules.json');

// Input fields whose value a tool executes as a shell command. Kept deliberately
// minimal: a rule matched against a field the tool does NOT execute is a false
// positive the operator cannot turn off, so widening this set is a one-line
// decision made here rather than an emergent property of field-name guessing.
const SHELL_PAYLOAD_FIELDS = ['command', 'script'];

// Rules may resolve their regex from a named module instead of an inline
// pattern, so a pattern set lives in exactly one place. Today only the credential
// vocabulary is shared (with the redactor); `"pattern_source": "secrets"` binds a
// rule to lib/secrets.DETECTION_REGEX.
const PATTERN_SOURCES = {
  secrets: () => secrets.DETECTION_REGEX
};

let _rulesCache = null;
let _provenanceCache = null;

// Find the nearest .t2helix/policy.json by walking up from cwd to the first
// .git boundary. Hooks run in the project root, so this usually resolves in
// one step. T2HELIX_POLICY_DIR overrides the walk (used in tests).
function findRepoPolicyFile() {
  const overrideDir = process.env.T2HELIX_POLICY_DIR;
  if (overrideDir !== undefined) {
    if (!overrideDir) return null; // empty string disables repo policy
    const candidate = path.join(overrideDir, '.t2helix', 'policy.json');
    return fs.existsSync(candidate) ? candidate : null;
  }
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, '.t2helix', 'policy.json');
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Merge repo-local policy rules (ADDITIVE only). Rules with IDs already in the
// base set are skipped. A repo policy can never override or remove a rule whose
// ID is already present — the bundled WITNESS floor is therefore immutable.
function mergeRepoPolicy(baseRules, policyPath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch {
    return baseRules; // malformed policy is ignored (fail-open)
  }
  const existingIds = new Set(baseRules.map(r => r.id));
  const added = [];
  for (const r of (raw.rules || [])) {
    if (existingIds.has(r.id)) continue; // existing ID — skip (can't override)
    try {
      added.push(prepareRule(r, 'repo-policy'));
    } catch {
      // fail-open: a repo rule with an invalid regex is skipped rather than crashing
    }
  }
  return [...baseRules, ...added];
}

function loadRules() {
  if (_rulesCache) return _rulesCache;

  // Step 1: bundled rules (the WITNESS floor; always loaded first)
  const bundled = JSON.parse(fs.readFileSync(BUNDLED_RULES, 'utf8'));
  let rules = (bundled.rules || []).map(r => prepareRule(r, 'bundled'));

  // Step 2: T2HELIX_DATA_DIR/compass/rules.json REPLACES bundled (existing power-user path)
  const userRulesPath = process.env.T2HELIX_DATA_DIR
    ? path.join(process.env.T2HELIX_DATA_DIR, 'compass', 'rules.json')
    : null;
  if (userRulesPath && fs.existsSync(userRulesPath)) {
    const userRaw = JSON.parse(fs.readFileSync(userRulesPath, 'utf8'));
    rules = (userRaw.rules || []).map(r => prepareRule(r, 'user-rules'));
  }

  // Step 3: repo-local .t2helix/policy.json MERGES (ADDITIVE only, never removes)
  const repoPolicy = findRepoPolicyFile();
  if (repoPolicy) {
    rules = mergeRepoPolicy(rules, repoPolicy);
  }

  _rulesCache = rules;
  return _rulesCache;
}

function resolveRegex(r) {
  if (r.pattern_source) {
    const src = PATTERN_SOURCES[r.pattern_source];
    if (!src) throw new Error(`compass: unknown pattern_source "${r.pattern_source}" on rule ${r.id}`);
    const rx = src();
    // Fail loud if the source ever stops resolving to a RegExp (e.g. a refactor
    // drops the export) — otherwise the credential rule would silently classify
    // OPEN, fail-open on a safety rule. pre-tool-use's classify() try/catch
    // surfaces this rather than crashing the host.
    if (!(rx instanceof RegExp)) {
      throw new Error(`compass: pattern_source "${r.pattern_source}" did not resolve to a RegExp on rule ${r.id}`);
    }
    return rx;
  }
  return r.pattern ? compileRegex(r.pattern) : null;
}

// A rule's `tool` has always named the surface the rule guards. That surface was
// named after the only tool known to reach it, so every shell rule says "Bash" —
// and lib/compass.classify skipped every rule whose tool did not equal the tool
// name, leaving any OTHER tool that runs a shell completely ungated while its
// rows logged as OPEN, indistinguishable from evaluated-and-cleared. Rules are
// therefore normalized to a CAPABILITY: `tool: "Bash"` (or an explicit
// `capability: "shell"`) guards shell execution wherever it happens. Rules naming
// a different tool keep exact scoping, and `tool_exact: true` opts a shell rule
// back out for the operator who genuinely wants Bash and nothing else.
function ruleCapability(r) {
  if (r.capability) return r.capability;
  if (r.tool === 'Bash' && r.tool_exact !== true) return 'shell';
  return null;
}

function prepareRule(r, source) {
  return { ...r, _regex: resolveRegex(r), _capability: ruleCapability(r), _source: source };
}

function ruleAppliesTo(rule, tool_name, capability) {
  if (rule.tool && rule.tool === tool_name) return true;
  if (rule._capability && rule._capability === capability) return true;
  return !rule.tool && !rule._capability;
}

/**
 * Does this tool call carry a shell-command-shaped payload, whatever the tool is
 * called? Only a string in one of SHELL_PAYLOAD_FIELDS counts — a tool whose
 * `command` field holds a number, an object, or nothing is not routed.
 */
function detectCapability({ tool_name, tool_input }) {
  const inp = tool_input || {};
  for (const field of SHELL_PAYLOAD_FIELDS) {
    const value = inp[field];
    if (typeof value === 'string' && value.trim()) {
      return { capability: 'shell', field, payload: value };
    }
  }
  return { capability: null, field: null, payload: null };
}

/** Which rules could evaluate this call at all, before any pattern is tried. */
function eligibility({ tool_name, tool_input }) {
  const rules = loadRules();
  const cap = detectCapability({ tool_name, tool_input });
  let rules_eligible = 0;
  for (const rule of rules) {
    if (ruleAppliesTo(rule, tool_name, cap.capability)) rules_eligible++;
  }
  return { capability: cap.capability, field: cap.field, rules_eligible };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Canonical projection for the ruleset hash. Load ORDER is part of the decision —
// classify() returns on the first match — so this is never sorted. The RESOLVED
// regex is projected rather than the declared `pattern`: a pattern_source rule
// has no pattern of its own, so hashing the declaration alone would be blind to
// a change in the vocabulary it points at.
function ruleProjection(r) {
  return {
    id: r.id,
    classification: r.classification,
    tool: r.tool || null,
    capability: r._capability,
    tool_exact: r.tool_exact === true,
    condition: r.condition || null,
    pattern_source: r.pattern_source || null,
    regex: r._regex ? r._regex.source : null,
    flags: r._regex ? r._regex.flags : null,
    source: r._source || 'bundled'
  };
}

/**
 * Identity of the ruleset in force. compass_log's decision columns can only say
 * OPEN/PAUSE/WITNESS, and the ruleset varies with T2HELIX_DATA_DIR and with the
 * repo's .t2helix/policy.json — so a historical row could not be reconstructed
 * even in principle without this. `manifest` carries every rule with a digest of
 * its unredacted pattern, so a stored manifest verifies against a candidate
 * rules file even if a free-text redaction pass touched it.
 */
function rulesetProvenance() {
  if (_provenanceCache) return _provenanceCache;
  const rules = loadRules();
  const manifest = rules.map(r => {
    const p = ruleProjection(r);
    return { ...p, pattern_sha256: p.regex == null ? null : sha256(p.regex) };
  });
  const sources = [];
  for (const r of rules) {
    const s = r._source || 'bundled';
    if (!sources.includes(s)) sources.push(s);
  }
  _provenanceCache = {
    ruleset_hash: `sha256:${sha256(JSON.stringify(manifest))}`,
    ruleset_source: sources.join('+') || 'bundled',
    rule_count: rules.length,
    manifest
  };
  return _provenanceCache;
}

function compileRegex(pattern) {
  let flags = '';
  let body = pattern;
  const m = body.match(/^\(\?([ims]+)\)/);
  if (m) {
    flags = m[1];
    body = body.slice(m[0].length);
  }
  return new RegExp(body, flags);
}

function actionString({ tool_name, tool_input }) {
  if (!tool_input) return '';
  if (tool_name === 'Bash') return tool_input.command || '';
  if (tool_name === 'Edit' || tool_name === 'Write') return tool_input.file_path || '';
  if (tool_name === 'MultiEdit') return tool_input.file_path || '';
  return JSON.stringify(tool_input).slice(0, 500);
}

function evaluateConditions(rule, ctx) {
  if (!rule.condition) return true;
  if (rule.condition === 'no_session_goal') {
    return !(ctx && ctx.has_goal);
  }
  return false;
}

// The MATCH haystack, deliberately distinct from actionString(). actionString is
// IDENTITY — PostToolUse recomputes it and the action:<hash> chain only pairs if
// it stays byte-identical — and for an unrecognized tool it is a JSON envelope,
// which means a rule can be satisfied by a KEY name and a pattern anchored on a
// leading token is defeated by the quoting. A shell payload is matched as the
// raw field value instead, exactly as Bash's command always has been.
function matchHaystack({ tool_name, tool_input }, cap) {
  if (cap && cap.capability === 'shell') return cap.payload;
  return actionString({ tool_name, tool_input });
}

function classify({ tool_name, tool_input }, ctx = {}) {
  const rules = loadRules();
  const cap = detectCapability({ tool_name, tool_input });
  const haystack = matchHaystack({ tool_name, tool_input }, cap);
  const provenance = rulesetProvenance();
  // Counted in its own pass: classify() returns on the first match, so a counter
  // incremented inside the loop below would report a smaller ruleset every time
  // a rule actually fired.
  const audit = {
    capability: cap.capability,
    rules_eligible: eligibility({ tool_name, tool_input }).rules_eligible,
    ruleset_hash: provenance.ruleset_hash,
    ruleset_source: provenance.ruleset_source
  };
  for (const rule of rules) {
    if (!ruleAppliesTo(rule, tool_name, cap.capability)) continue;
    if (rule._regex) {
      if (!rule._regex.test(haystack)) continue;
    } else if (rule.condition) {
      if (!evaluateConditions(rule, ctx)) continue;
    } else {
      continue;
    }
    return {
      classification: rule.classification,
      rule_id: rule.id,
      reason: rule.reason,
      ...audit
    };
  }
  return { classification: 'OPEN', rule_id: null, reason: null, ...audit };
}

function summarizeAction({ tool_name, tool_input }) {
  const s = actionString({ tool_name, tool_input });
  if (s.length <= 200) return `${tool_name}: ${s}`;
  return `${tool_name}: ${s.slice(0, 200)}…`;
}

function _resetCache() {
  _rulesCache = null;
  _provenanceCache = null;
}

module.exports = {
  classify,
  summarizeAction,
  loadRules,
  findRepoPolicyFile,
  mergeRepoPolicy,
  detectCapability,
  eligibility,
  rulesetProvenance,
  ruleAppliesTo,
  SHELL_PAYLOAD_FIELDS,
  _resetCache
};
