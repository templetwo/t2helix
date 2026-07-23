'use strict';

// Structured-tool adapters for Action IR. Prefer native fields over JSON flattening.

function adaptStructuredTool(ir, tool, input, context = {}) {
  const tool_name = tool;
  const inp = input || {};

  if (tool_name === 'Edit' || tool_name === 'Write' || tool_name === 'MultiEdit') {
    const file_path = inp.file_path || inp.path || null;
    const op = tool_name === 'Write' ? 'write' : tool_name === 'MultiEdit' ? 'multi-edit' : 'edit';
    ir.segments = [{
      executable: op,
      argv: file_path ? [file_path] : [],
      flags: [],
      flag_set: [],
      operands: file_path ? [file_path] : [],
      operators: [],
      redirections: [],
      wildcard_operands: file_path && /[*?]/.test(file_path) ? [0] : [],
      quoted_literals: [],
      heredoc_bodies: [],
      interpreter_boundary: null,
      uncertainty: file_path ? [] : [{ code: 'missing-path' }],
      structured: {
        tool: tool_name,
        file_path,
        content_class: classifyContent(inp),
        old_string_len: typeof inp.old_string === 'string' ? inp.old_string.length : null,
        new_string_len: typeof inp.new_string === 'string' ? inp.new_string.length : null,
        content_len: typeof inp.content === 'string' ? inp.content.length : null
      }
    }];
    if (file_path) ir.mutation_targets = [file_path];
    return ir;
  }

  // Grok peer tool — keep structured, do not flatten into a regex haystack
  if (tool_name === 'Grok') {
    const action = inp.action || inp.command || JSON.stringify(inp).slice(0, 200);
    ir.segments = [{
      executable: 'grok',
      argv: [String(action)],
      flags: [],
      flag_set: [],
      operands: [String(action)],
      operators: [],
      redirections: [],
      wildcard_operands: [],
      quoted_literals: [],
      heredoc_bodies: [],
      interpreter_boundary: null,
      uncertainty: [],
      structured: { tool: 'Grok', raw: inp }
    }];
    return ir;
  }

  // Unknown structured tools: preserve name + args, attach uncertainty
  const keys = Object.keys(inp);
  ir.segments = [{
    executable: String(tool_name || 'unknown').toLowerCase(),
    argv: keys.map(k => `${k}=${summarizeVal(inp[k])}`),
    flags: [],
    flag_set: [],
    operands: keys,
    operators: [],
    redirections: [],
    wildcard_operands: [],
    quoted_literals: [],
    heredoc_bodies: [],
    interpreter_boundary: null,
    uncertainty: [{ code: 'unknown-tool', tool: tool_name }],
    structured: { tool: tool_name, keys, input: summarizeInput(inp) }
  }];
  ir.uncertainty.push({ code: 'unknown-tool', tool: tool_name });
  return ir;
}

function classifyContent(inp) {
  const text = inp.content || inp.new_string || '';
  if (typeof text !== 'string') return 'none';
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return 'private-key';
  if (/\b(sk-|ghp_|AKIA)[A-Za-z0-9]/.test(text)) return 'credential-shaped';
  return 'text';
}

function summarizeVal(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 80) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  } catch {
    return '[unserializable]';
  }
}

function summarizeInput(inp) {
  const out = {};
  for (const [k, v] of Object.entries(inp || {})) {
    out[k] = summarizeVal(v);
  }
  return out;
}

module.exports = {
  adaptStructuredTool,
  classifyContent
};
