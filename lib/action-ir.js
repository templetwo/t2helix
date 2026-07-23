'use strict';

// Action Intermediate Representation — tool-neutral normalization for Compass V2.
// Parser version is part of the identity contract (leases bind to hash + version).

const crypto = require('crypto');
const { parseBashCommand } = require('./action-ir/bash');
const { adaptStructuredTool } = require('./action-ir/tools');

const PARSER_VERSION = 'action-ir/0.12.0';

function emptyIR(tool, context = {}) {
  return {
    tool: tool || null,
    parser_version: PARSER_VERSION,
    segments: [],
    mutation_targets: [],
    cwd: context.cwd ?? process.cwd(),
    uncertainty: [],
    normalized_action_hash: null,
    error: null
  };
}

/**
 * Canonical form used for hashing. Stable across irrelevant whitespace and
 * harmless quoting differences. Includes parser_version so upgrades invalidate
 * leases that depended on a prior parse.
 */
function canonicalizeAction(ir) {
  const segments = (ir.segments || []).map(seg => ({
    executable: normalizeExecutable(seg.executable),
    argv: (seg.argv || []).map(normalizeArg),
    flags: [...(seg.flags || [])].sort(),
    operands: (seg.operands || []).map(normalizeArg),
    operators: seg.operators || [],
    redirections: seg.redirections || [],
    wildcard_operands: seg.wildcard_operands || [],
    interpreter_boundary: seg.interpreter_boundary
      ? {
          kind: seg.interpreter_boundary.kind,
          interpreter: seg.interpreter_boundary.interpreter,
          nested: (seg.interpreter_boundary.nested_segments || []).map(ns => ({
            executable: normalizeExecutable(ns.executable),
            argv: (ns.argv || []).map(normalizeArg)
          })),
          nested_executable: seg.interpreter_boundary.nested_executable || null
        }
      : null
  }));
  return {
    parser_version: ir.parser_version || PARSER_VERSION,
    tool: ir.tool,
    cwd: ir.cwd || null,
    segments
  };
}

function normalizeExecutable(exe) {
  if (!exe) return '';
  return String(exe).trim().replace(/^\.?\//, '').toLowerCase();
}

function normalizeArg(a) {
  return String(a ?? '').trim();
}

function hashCanonical(canonical) {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
  return `sha256:${digest}`;
}

/**
 * Parse tool input into Action IR.
 * @param {string} tool
 * @param {object} input
 * @param {object} [context]
 */
function parseToIR(tool, input, context = {}) {
  const ir = emptyIR(tool, context);
  try {
    if (tool === 'Bash') {
      const command = (input && input.command) || '';
      const parsed = parseBashCommand(command);
      ir.segments = parsed.segments.map(stripInternal);
      ir.mutation_targets = parsed.mutation_targets;
      ir.uncertainty = parsed.uncertainty || [];
      // Collect segment-level uncertainty
      for (const seg of parsed.segments) {
        if (seg.uncertainty && seg.uncertainty.length) {
          ir.uncertainty.push(...seg.uncertainty);
        }
      }
    } else {
      adaptStructuredTool(ir, tool, input || {}, context);
    }
  } catch (e) {
    ir.error = {
      code: 'parser-exception',
      message: e && e.message ? e.message : String(e)
    };
    ir.uncertainty.push({ code: 'parser-exception', message: ir.error.message });
  }

  const canonical = canonicalizeAction(ir);
  ir.normalized_action_hash = hashCanonical(canonical);
  return ir;
}

/** Drop non-serializable / internal fields before logging. */
function stripInternal(seg) {
  return {
    executable: seg.executable,
    argv: seg.argv || [],
    flags: seg.flags || [],
    flag_set: seg.flag_set || [],
    operands: seg.operands || [],
    operators: seg.operators || [],
    redirections: seg.redirections || [],
    wildcard_operands: seg.wildcard_operands || [],
    quoted_literals: seg.quoted_literals || [],
    heredoc_bodies: seg.heredoc_bodies || [],
    interpreter_boundary: seg.interpreter_boundary
      ? {
          kind: seg.interpreter_boundary.kind,
          interpreter: seg.interpreter_boundary.interpreter,
          nested_segments: (seg.interpreter_boundary.nested_segments || []).map(stripInternal),
          nested_executable: seg.interpreter_boundary.nested_executable || null,
          nested_argv: seg.interpreter_boundary.nested_argv || null
        }
      : null,
    uncertainty: seg.uncertainty || [],
    structured: seg.structured || null,
    span: seg.span || null
  };
}

function summarizeIR(ir) {
  if (!ir || !ir.segments || !ir.segments.length) {
    return `${ir && ir.tool ? ir.tool : 'unknown'}: (empty)`;
  }
  const parts = ir.segments.map(seg => {
    const exe = seg.executable || '?';
    const flags = (seg.flags || []).join(' ');
    const ops = (seg.operands || []).slice(0, 3).join(' ');
    return [exe, flags, ops].filter(Boolean).join(' ');
  });
  const s = parts.join(' | ');
  return s.length <= 160 ? s : s.slice(0, 160) + '…';
}

module.exports = {
  PARSER_VERSION,
  parseToIR,
  canonicalizeAction,
  hashCanonical,
  summarizeIR,
  emptyIR
};
