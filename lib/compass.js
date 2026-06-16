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

function loadRules() {
  if (_rulesCache) return _rulesCache;
  const userRules = process.env.T2HELIX_DATA_DIR
    ? path.join(process.env.T2HELIX_DATA_DIR, 'compass', 'rules.json')
    : null;
  let active = BUNDLED_RULES;
  if (userRules && fs.existsSync(userRules)) active = userRules;
  const raw = JSON.parse(fs.readFileSync(active, 'utf8'));
  _rulesCache = (raw.rules || []).map(r => ({
    ...r,
    _regex: resolveRegex(r)
  }));
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

module.exports = { classify, summarizeAction, loadRules, _resetCache };
