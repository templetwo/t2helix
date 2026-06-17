'use strict';

const fs = require('fs');
const path = require('path');
const secrets = require('./secrets');

const BUNDLED_RULES = path.join(__dirname, 'rules', 'compass-rules.json');

// Rules may resolve their regex from a named module instead of an inline
// pattern, so a pattern set lives in exactly one place. Today only the credential
// vocabulary is shared (with the redactor); `"pattern_source": "secrets"` binds a
// rule to lib/secrets.DETECTION_REGEX.
const PATTERN_SOURCES = {
  secrets: () => secrets.DETECTION_REGEX
};

let _rulesCache = null;

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
      added.push({ ...r, _regex: resolveRegex(r), _source: 'repo-policy' });
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
  let rules = (bundled.rules || []).map(r => ({ ...r, _regex: resolveRegex(r) }));

  // Step 2: T2HELIX_DATA_DIR/compass/rules.json REPLACES bundled (existing power-user path)
  const userRulesPath = process.env.T2HELIX_DATA_DIR
    ? path.join(process.env.T2HELIX_DATA_DIR, 'compass', 'rules.json')
    : null;
  if (userRulesPath && fs.existsSync(userRulesPath)) {
    const userRaw = JSON.parse(fs.readFileSync(userRulesPath, 'utf8'));
    rules = (userRaw.rules || []).map(r => ({ ...r, _regex: resolveRegex(r) }));
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

function classify({ tool_name, tool_input }, ctx = {}) {
  const rules = loadRules();
  const haystack = actionString({ tool_name, tool_input });
  for (const rule of rules) {
    if (rule.tool && rule.tool !== tool_name) continue;
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
      reason: rule.reason
    };
  }
  return { classification: 'OPEN', rule_id: null, reason: null };
}

function summarizeAction({ tool_name, tool_input }) {
  const s = actionString({ tool_name, tool_input });
  if (s.length <= 200) return `${tool_name}: ${s}`;
  return `${tool_name}: ${s.slice(0, 200)}…`;
}

function _resetCache() {
  _rulesCache = null;
}

module.exports = { classify, summarizeAction, loadRules, findRepoPolicyFile, mergeRepoPolicy, _resetCache };
