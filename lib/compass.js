'use strict';

const fs = require('fs');
const path = require('path');

const BUNDLED_RULES = path.join(__dirname, 'rules', 'compass-rules.json');

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
    _regex: r.pattern ? compileRegex(r.pattern) : null
  }));
  return _rulesCache;
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
