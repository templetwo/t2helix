'use strict';

const fs = require('fs');
const path = require('path');
const secrets = require('./secrets');
const { LONG_FLAG_LETTERS } = require('./action-ir/bash');

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

// Shell spellings the rules would otherwise miss. Both rewrites are deliberately
// narrow, because the alternative — widening the patterns — was tried twice and
// reverted twice (rule-order shadowing; a cubic idiom).
//
//   dequote     strips a paired quote ONLY around a whitespace-free span, so
//               `rm "-rf" x` reads as `rm -rf x` while a quoted sentence keeps
//               its quotes and stays exactly as written.
//   flag forms  maps long flags onto the short letters the rule flag classes
//               already enumerate, from the same table the Action IR parser uses
//               so the two layers cannot drift. The lookarounds keep a longer
//               flag that merely starts with one of them (--force-with-lease)
//               intact.
const LONG_FLAG_PATTERN = new RegExp(
  `(?<![\\w-])(?:${Object.keys(LONG_FLAG_LETTERS).join('|')})(?![\\w-])`,
  'g'
);

function normalizeForMatch(s) {
  return s
    .replace(/(["'])([^"'\s]*)\1/g, '$2')
    .replace(LONG_FLAG_PATTERN, m => `-${LONG_FLAG_LETTERS[m]}`);
}

function evaluateConditions(rule, ctx) {
  if (!rule.condition) return true;
  if (rule.condition === 'no_session_goal') {
    return !(ctx && ctx.has_goal);
  }
  return false;
}

function firstMatch(rules, haystack, tool_name, ctx) {
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
  return null;
}

function classify({ tool_name, tool_input }, ctx = {}) {
  const rules = loadRules();
  const haystack = actionString({ tool_name, tool_input });

  const asWritten = firstMatch(rules, haystack, tool_name, ctx);
  if (asWritten) return asWritten;

  // Second pass on the normalized spelling, and ONLY once the command as written
  // has been matched and found clean. That ordering is the whole safety argument:
  // normalization may ADD a denial, and can never change WHICH rule fires on a
  // command that already denied. Drop it and rm-rf-wildcard — first in a
  // first-match-wins list, and a migrated family — starts capturing chained
  // commands whose real gate is a later rule, whereupon the migrated-family merge
  // clears the whole verdict: `rm --force <file> && git push --force` measured
  // DENY under every mode before, ALLOW under enforce after. That is the same
  // failure the 2026-07-26 pattern widening was reverted for.
  //
  // Quoting is shell syntax, so this reaches shell text only. actionString()
  // serializes a non-Bash tool_input to JSON, where quotes are structure, and a
  // repo policy may scope a rule to any tool.
  if (tool_name !== 'Bash') return { classification: 'OPEN', rule_id: null, reason: null };
  const normalized = normalizeForMatch(haystack);
  if (normalized === haystack) return { classification: 'OPEN', rule_id: null, reason: null };

  return firstMatch(rules, normalized, tool_name, ctx)
    || { classification: 'OPEN', rule_id: null, reason: null };
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
