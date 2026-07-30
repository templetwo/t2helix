'use strict';

const fs = require('fs');
const path = require('path');
const secrets = require('./secrets');

const BUNDLED_RULES = path.join(__dirname, 'rules', 'compass-rules.json');

// A fourth classification, for the decision the compass did NOT reach. OPEN,
// PAUSE and WITNESS can each only report what an evaluation found; none of them
// can report that the evaluation never happened, which is why a hook killed
// mid-regex and a hook that looked and cleared were the same row in compass_log
// (and the same empty `{}` to the harness).
const NOT_EVALUATED = 'NOT_EVALUATED';

// The only classification that lets a tool call through. Every allow/block site
// asks this instead of comparing strings, so a classification a caller has never
// heard of cannot fall through as "allowed".
function isClearance(classification) {
  return classification === 'OPEN';
}

// Rule evaluation runs on a budget. classify() returns on the first match, so a
// pattern that backtracks super-linearly burns the whole PreToolUse timeout and
// every rule after it in the list is never tested — the hook is killed and emits
// nothing, which the harness reads as no objection. The bundled patterns are held
// linear by test/compass-fail-closed.js, but a repo-local policy compiles operator
// regexes this file has never seen, and there the budget is the only backstop.
const DEFAULT_CLASSIFY_BUDGET_MS = 1200;
const DEFAULT_RULE_BUDGET_MS = 400;

function budgetMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

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
  const classifyBudget = budgetMs('T2HELIX_CLASSIFY_BUDGET_MS', DEFAULT_CLASSIFY_BUDGET_MS);
  const ruleBudget = budgetMs('T2HELIX_RULE_BUDGET_MS', DEFAULT_RULE_BUDGET_MS);
  const started = Date.now();
  const slow_rules = [];

  for (let i = 0; i < rules.length; i++) {
    const elapsed = Date.now() - started;
    if (elapsed > classifyBudget) {
      // Stopping short is the whole point: the rules below this one have not run,
      // and saying OPEN here would be the fail-open the budget exists to close.
      return {
        classification: NOT_EVALUATED,
        rule_id: 'classify-budget-exceeded',
        reason: `Compass spent ${elapsed}ms on the first ${i} of ${rules.length} rules; the remaining ${rules.length - i} never ran, so this action is unevaluated rather than cleared.`,
        evidence: {
          elapsed_ms: elapsed,
          budget_ms: classifyBudget,
          rules_checked: rules.slice(0, i).map(r => r.id),
          rules_unevaluated: rules.slice(i).map(r => r.id),
          slow_rules
        }
      };
    }

    const rule = rules[i];
    if (rule.tool && rule.tool !== tool_name) continue;

    const ruleStarted = Date.now();
    let matched;
    if (rule._regex) {
      matched = rule._regex.test(haystack);
    } else if (rule.condition) {
      matched = evaluateConditions(rule, ctx);
    } else {
      matched = false;
    }
    const ruleMs = Date.now() - ruleStarted;
    // A regex cannot be interrupted once entered, so a rule that overruns is
    // recorded rather than prevented — the record is what names the offender
    // when the budget then trips on the next iteration.
    if (ruleMs > ruleBudget) slow_rules.push({ rule_id: rule.id, ms: ruleMs });

    if (!matched) continue;
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

module.exports = {
  classify,
  summarizeAction,
  loadRules,
  findRepoPolicyFile,
  mergeRepoPolicy,
  isClearance,
  NOT_EVALUATED,
  _resetCache
};
