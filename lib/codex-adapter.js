'use strict';

/**
 * T2Helix adapter and installer for Codex.
 *
 * Codex can share the same chronicle through MCP, but it has no equivalents of
 * Claude Code's UserPromptSubmit or PreToolUse hooks. Recall is opt-in and the
 * compass result returned here is advisory; this module cannot intercept or
 * deny a Codex tool call.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const chronicle = require('./chronicle');
const { isClearance } = require('./compass');
const { classifyV2 } = require('./compass-v2');

const ADAPTER_VERSION = '1.0.0';
const CONFIG_START = '# >>> T2HELIX CODEX CONNECTOR >>>';
const CONFIG_END = '# <<< T2HELIX CODEX CONNECTOR <<<';
const INSTRUCTIONS_START = '<!-- >>> T2HELIX CODEX CONNECTOR >>> -->';
const INSTRUCTIONS_END = '<!-- <<< T2HELIX CODEX CONNECTOR <<< -->';

function sharedDataDir(homeDir = os.homedir()) {
  return path.join(
    homeDir,
    '.claude',
    'plugins',
    'data',
    't2helix-templetwo-t2helix'
  );
}

function currentSession(fallback = 'codex-direct') {
  try {
    return chronicle.readCurrentSession() || fallback;
  } catch (_) {
    return fallback;
  }
}

/**
 * Recall shared T2Helix memory directly from a Codex-side script.
 * Normal Codex sessions should use the registered MCP recall tool.
 */
function codexRecall(query, opts = {}) {
  return chronicle.recall({
    query,
    topK: opts.topK ?? 6,
    layer: opts.layer,
    include_meta: opts.include_meta || false,
    tag: opts.tag,
    min_intensity: opts.min_intensity,
    since: opts.since,
    until: opts.until
  });
}

/** Write a durable insight to the same chronicle used by Claude Code. */
function codexRecord(content, opts = {}) {
  const session_id = opts.session_id || currentSession(`codex-direct-${Date.now()}`);
  return chronicle.record({
    session_id,
    content,
    layer: opts.layer || 'hypothesis',
    domain: opts.domain || 'codex',
    tags: [...(opts.tags || []), 'source:codex'],
    intensity: opts.intensity ?? 0.6
  });
}

/**
 * Boot a direct Codex-side session with compact shared state and recall.
 * Calling this function is a discipline, not an automatic prompt hook.
 */
async function codexBoot(options = {}) {
  const sessionId = options.session_id || currentSession();
  let memory = [];
  let state = null;
  const warnings = [];

  try {
    memory = codexRecall(
      options.query || 'current context goal recent work',
      {
        topK: options.topK ?? 8,
        layer: options.layer || ['ground_truth', 'hypothesis'],
        include_meta: false
      }
    );
  } catch (e) {
    warnings.push(`chronicle recall unavailable at boot: ${e.message}`);
  }

  try {
    state = chronicle.getState(sessionId);
  } catch (e) {
    warnings.push(`chronicle state unavailable at boot: ${e.message}`);
  }

  return {
    status: warnings.length ? 'degraded' : 'booted',
    adapter: 't2helix-codex',
    version: ADAPTER_VERSION,
    sessionId,
    goal: state ? state.goal : null,
    openThreads: state ? state.open_threads : [],
    memoryCount: memory.length,
    memory: memory.slice(0, 3),
    dataDir: chronicle.dataDir ? chronicle.dataDir() : null,
    automaticRecall: false,
    compassEnforced: false,
    warnings,
    note:
      'Codex has no UserPromptSubmit or PreToolUse hooks. Recall must be called; compass advice cannot block tools.'
  };
}

/**
 * Classify a proposed action through Compass V2 without enforcing it.
 *
 * A WITNESS or PAUSE result is a strong recommendation to stop, but Codex can
 * still execute the action unless the agent/human voluntarily honors it.
 */
function codexCompassCheck(action, context = {}) {
  let structured;
  if (typeof action === 'string') {
    structured = {
      tool_name: context.tool_name || 'Bash',
      tool_input: context.tool_input || { command: action }
    };
  } else {
    structured = action || { tool_name: 'Bash', tool_input: {} };
  }

  try {
    const result = classifyV2(structured, {
      cwd: context.cwd || process.cwd(),
      has_goal: context.has_goal || false
    });
    const classification = result.active.classification || 'OPEN';
    // Ordered so that PROCEED is reachable only from an actual clearance. The
    // previous shape defaulted to PROCEED, which would have read a NOT_EVALUATED
    // as "nothing matched".
    const recommendation = isClearance(classification)
      ? 'PROCEED_WITH_NORMAL_JUDGMENT'
      : classification === 'PAUSE'
        ? 'PAUSE_AND_CONFIRM'
        : 'STOP_AND_REQUEST_HUMAN_REVIEW';

    return {
      advisory: true,
      enforced: false,
      classification,
      recommendation,
      reason: result.active.reason || null,
      rule: result.active.rule_id || null,
      actionSummary: result.action_summary,
      displaySummary: result.display_summary,
      mode: result.mode,
      normalizedActionHash: result.ir
        ? result.ir.normalized_action_hash
        : null,
      note:
        'Advisory only: Codex has no PreToolUse interception hook, so this result cannot deny the action.'
    };
  } catch (e) {
    return {
      advisory: true,
      enforced: false,
      classification: 'UNAVAILABLE',
      recommendation: 'DO_NOT_TREAT_AS_CLEARANCE',
      reason: e.message,
      note:
        'Compass classification failed and cannot be treated as approval. Codex still has no enforcement hook.'
    };
  }
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function stripMarkedBlocks(text, startMarker, endMarker) {
  let out = text;
  while (out.includes(startMarker)) {
    const start = out.indexOf(startMarker);
    const end = out.indexOf(endMarker, start + startMarker.length);
    if (end === -1) {
      throw new Error(`found ${startMarker} without matching ${endMarker}`);
    }
    out = out.slice(0, start) + out.slice(end + endMarker.length);
  }
  if (out.includes(endMarker)) {
    throw new Error(`found ${endMarker} without matching ${startMarker}`);
  }
  return out;
}

function stripLegacyMcpSection(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    const section = line.trim().match(/^\[([^\]]+)\]$/);
    if (section) {
      if (section[1] === 'mcp_servers.t2helix') {
        skipping = true;
        continue;
      }
      if (skipping && section[1].startsWith('mcp_servers.t2helix.')) {
        continue;
      }
      skipping = false;
    }
    if (!skipping) kept.push(line);
  }

  return kept.join('\n');
}

function appendManagedBlock(text, block) {
  const base = text.trimEnd();
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

function buildConfigBlock({ nodeCommand, serverPath, dataDir, startupTimeoutSec }) {
  return [
    CONFIG_START,
    '# MCP exposes shared memory and an advisory compass; Codex has no hook enforcement.',
    '[mcp_servers.t2helix]',
    `command = ${tomlString(nodeCommand)}`,
    `args = [${tomlString(serverPath)}, "--transport", "stdio"]`,
    `env = { T2HELIX_DATA_DIR = ${tomlString(dataDir)} }`,
    `startup_timeout_sec = ${Number(startupTimeoutSec)}`,
    CONFIG_END
  ].join('\n');
}

function buildInstructionsBlock() {
  return [
    INSTRUCTIONS_START,
    '## T2Helix discipline for Codex (advisory, not enforced)',
    '',
    'Codex has no equivalents of Claude Code\'s `UserPromptSubmit` or `PreToolUse` hooks. The T2Helix MCP server provides callable tools only: recall is not automatic, and compass results cannot technically block a Codex action.',
    '',
    '- At the start of a non-trivial session, call T2Helix `get_state`, then `recall` with a short task-specific query before planning or editing.',
    '- Before any destructive, irreversible, privilege-escalating, production-mutating, or otherwise high-impact action, call `dry_run_compass` (and `explain_compass` when needed). Treat WITNESS as stop-and-request-human-review and PAUSE as pause-and-confirm—but never claim this is enforced.',
    '- Use `set_goal` for a durable session objective and concrete acceptance criteria. Use `record` for decisions or findings worth carrying across sessions; do not record routine transcript noise.',
    '- If T2Helix is unavailable or was not consulted, say so plainly. Never describe Codex recall as automatic or the advisory compass as a safety boundary.',
    '',
    'These rules are agent discipline, not interception. A Codex tool call can bypass them.',
    INSTRUCTIONS_END
  ].join('\n');
}

function backupName(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${filePath}.t2helix-backup-${stamp}-${process.pid}`;
}

function writeAtomicWithBackup(filePath, content) {
  const exists = fs.existsSync(filePath);
  const current = exists ? fs.readFileSync(filePath, 'utf8') : '';
  if (current === content) {
    return { changed: false, backupPath: null };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let backupPath = null;
  let mode = 0o600;
  if (exists) {
    mode = fs.statSync(filePath).mode & 0o777;
    backupPath = backupName(filePath);
    fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  }

  const tempPath = `${filePath}.t2helix-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode });
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
    throw e;
  }
  return { changed: true, backupPath };
}

/**
 * Register the stdio MCP server and install global Codex usage discipline.
 * Existing files are preserved outside marker-owned blocks and backed up before
 * any change. Options exist so tests never touch the operator's real home.
 */
function codexInit(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const dataDir = options.dataDir
    || process.env.T2HELIX_DATA_DIR
    || sharedDataDir(homeDir);
  const configPath = options.configPath
    || path.join(homeDir, '.codex', 'config.toml');
  const instructionsPath = options.instructionsPath
    || path.join(homeDir, '.codex', 'instructions.md');
  const nodeCommand = options.nodeCommand || process.execPath;
  const serverPath = options.serverPath || path.join(repoRoot, 'mcp', 'server.js');
  const startupTimeoutSec = options.startupTimeoutSec ?? 20;

  try {
    fs.mkdirSync(dataDir, { recursive: true });

    // A stdio initialize/tools-list handshake does not load better-sqlite3, so
    // it can look healthy under the wrong Node ABI and fail on first recall.
    // Validate the real DB surface before changing Codex configuration.
    let health = null;
    if (!options.skipHealthCheck) {
      health = chronicle.health();
      if (!health || health.degraded) {
        const hint = health && health.hint ? ` ${health.hint}` : '';
        throw new Error(
          `T2Helix chronicle health check failed under ${process.execPath}.${hint}`
        );
      }
    }

    const existingConfig = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, 'utf8')
      : '';
    const configWithoutMarkers = stripMarkedBlocks(
      existingConfig,
      CONFIG_START,
      CONFIG_END
    );
    const configBase = stripLegacyMcpSection(configWithoutMarkers);
    const nextConfig = appendManagedBlock(
      configBase,
      buildConfigBlock({ nodeCommand, serverPath, dataDir, startupTimeoutSec })
    );

    const existingInstructions = fs.existsSync(instructionsPath)
      ? fs.readFileSync(instructionsPath, 'utf8')
      : '';
    const instructionsBase = stripMarkedBlocks(
      existingInstructions,
      INSTRUCTIONS_START,
      INSTRUCTIONS_END
    );
    const nextInstructions = appendManagedBlock(
      instructionsBase,
      buildInstructionsBlock()
    );

    const configWrite = writeAtomicWithBackup(configPath, nextConfig);
    const instructionsWrite = writeAtomicWithBackup(
      instructionsPath,
      nextInstructions
    );

    return {
      ok: true,
      adapter: 't2helix-codex',
      version: ADAPTER_VERSION,
      dataDir,
      configPath,
      instructionsPath,
      serverPath,
      nodeCommand,
      health,
      configChanged: configWrite.changed,
      instructionsChanged: instructionsWrite.changed,
      configBackup: configWrite.backupPath,
      instructionsBackup: instructionsWrite.backupPath,
      automaticRecall: false,
      compassEnforced: false,
      message:
        'Codex MCP registered. Restart Codex, then follow the installed recall/compass discipline; hooks are not available.'
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      configPath,
      instructionsPath
    };
  }
}

module.exports = {
  codexBoot,
  codexRecall,
  codexRecord,
  codexCompassCheck,
  codexInit,
  sharedDataDir,
  ADAPTER_VERSION,
  CONFIG_START,
  CONFIG_END,
  INSTRUCTIONS_START,
  INSTRUCTIONS_END
};
