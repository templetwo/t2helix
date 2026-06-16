#!/usr/bin/env node
'use strict';

const readline = require('readline');
const http = require('http');
const ch = require('../lib/chronicle');

const SERVER_INFO = { name: 't2helix', version: require('../package.json').version };

// Transport flag: --transport stdio (default) | --transport sse
// Port flag:      --port 3742 (default, SSE only)
const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
}
const TRANSPORT = argValue('--transport') || 'stdio';
const PORT = parseInt(argValue('--port') || '3742', 10);

const TOOLS = [
  {
    name: 'recall',
    description: 'Search the local T2Helix chronicle for past insights related to a query. Use before tackling non-trivial coding work. By default excludes hook-generated meta entries (PostToolUse echoes, Stop syntheses) so the surface is curated content first. Pass layer=\'ground_truth\' for confirmed-fact queries; include_meta=true to see hook entries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms — short, content-heavy phrases work best.' },
        topK: { type: 'number', default: 5 },
        layer: {
          oneOf: [
            { type: 'string', enum: ['hypothesis', 'ground_truth', 'reflection'] },
            { type: 'array', items: { type: 'string', enum: ['hypothesis', 'ground_truth', 'reflection'] } }
          ],
          description: "Filter by layer. 'ground_truth' = confirmed facts; 'hypothesis' = in-progress; 'reflection' = syntheses + archived goals. Single string or array."
        },
        min_intensity: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Exclude entries below this intensity. Useful when querying for high-confidence findings only.'
        },
        include_meta: {
          type: 'boolean',
          default: false,
          description: 'When true, includes session-action (PostToolUse) and session-synthesis (Stop) hook entries. Default false to keep recall focused on curated content.'
        },
        since: {
          type: 'number',
          description: 'Lower bound on created_at (epoch ms). Omit for no lower bound. For a 7-day window: Date.now() - 7*86400000.'
        },
        until: {
          type: 'number',
          description: 'Upper bound on created_at (epoch ms). Omit for no upper bound.'
        },
        tag: {
          type: 'string',
          description: "Filter to entries whose tags array contains this exact string (e.g. 'outcome:failure', 'archived-goal'). Quoted-token match — 'outcome:fail' will NOT match 'outcome:failure'."
        }
      },
      required: ['query']
    }
  },
  {
    name: 'record',
    description: 'Capture a new insight inline during work (e.g., a debugging breakthrough or design decision worth remembering across sessions).',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        domain: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        intensity: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        layer: { type: 'string', enum: ['hypothesis', 'ground_truth', 'reflection'], default: 'hypothesis' }
      },
      required: ['content']
    }
  },
  {
    name: 'record_method',
    description: 'Capture a reusable PROCEDURE that demonstrably worked, keyed to a task shape, so a future session facing the same kind of task can recall the method (not just facts). Use when a sequence of steps achieved a goal. Stored as a domain:\'method\' insight; surfaced only via the targeted method lookup, never the generic recall firehose. Redaction applies, so a step containing a credential is fingerprinted automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        shape: { type: 'string', description: 'A short task-shape slug, ideally <verb>-<object> (e.g. "rotate-bridge-token", "wire-mcp-tool"). This is the retrieval key.' },
        steps: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'The ordered steps that worked — the command/tool pattern, compact (a playbook, not a transcript).'
        },
        acceptance: { type: 'string', description: 'The signal that confirms the method succeeded (e.g. "tests green", "heartbeat 200").' },
        tool_classes: { type: 'array', items: { type: 'string' }, description: 'Tool classes the method uses (e.g. ["bash","edit"]) — disambiguates retrieval beyond text similarity.' }
      },
      required: ['shape', 'steps']
    }
  },
  {
    name: 'set_goal',
    description: 'Define or update the current session goal. Anchors subsequent work. Optionally pass acceptance_criteria (concrete done-signals) to make the goal boundary-active: the Stop synthesis then tracks per-criterion progress and flags what is left unfinished. If you set a goal without criteria, the response offers a lightweight decomposition you may follow up on (non-blocking).',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        why: { type: 'string' },
        acceptance_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Concrete, checkable done-signals that bound the goal (e.g. ["tests green", "PR opened", "deployed"]). 2-4 is plenty. Surfaced in the Stop synthesis with a soft per-criterion progress marker.'
        }
      },
      required: ['goal']
    }
  },
  {
    name: 'open_thread',
    description: 'Capture an unresolved question to revisit later, without losing focus on the current work.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        domain: { type: 'string' },
        context: { type: 'string' }
      },
      required: ['question']
    }
  },
  {
    name: 'resolve_thread',
    description: 'Close an open thread by id with a resolution. The thread stops surfacing in get_state.open_threads and gets stamped with resolved_at + resolution text.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Thread id (from open_thread or get_state.open_threads).' },
        resolution: { type: 'string', description: 'How the question was resolved — facts, decision, or pointer to the entry that answered it.' }
      },
      required: ['id', 'resolution']
    }
  },
  {
    name: 'get_state',
    description: 'Get the current session goal, recent open threads, and recent insights.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'recall_compass',
    description: 'Query the compass log of past PreToolUse classifications. Useful for reviewing which tool calls hit safety rules and which passed through.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 20 },
        classification: {
          type: 'string',
          enum: ['WITNESS', 'PAUSE', 'OPEN'],
          description: 'Filter by classification. Omit for all.'
        },
        matched_only: {
          type: 'boolean',
          default: false,
          description: 'When true, only return entries where a rule matched (excludes OPEN pass-throughs).'
        }
      }
    }
  },
  {
    name: 'confirm_pending',
    description: 'Approve a pending PAUSE confirmation by token. After approval, retry the original tool call within 10 minutes; the compass will consume the approval and let it through. Single-use per token.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Token from the deny message (e.g., "ab12cd34ef567890").' }
      },
      required: ['token']
    }
  },
  {
    name: 'list_pending',
    description: 'List unexpired pending or approved confirmation requests. Useful for reviewing what is waiting to be approved or has been approved but not yet consumed.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Filter to a specific session_id. Omit for all unexpired entries.' },
        limit: { type: 'number', default: 20 }
      }
    }
  }
];

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function err(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function textContent(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

function sessionId(args) {
  // Resolution chain (highest precedence first):
  //   1. Explicit session_id in tool args (rare; reserved for testing/override)
  //   2. T2HELIX_SESSION_ID env var (manual override)
  //   3. Current-session state file written by hooks (the real signature)
  //   4. Literal 'mcp-session' fallback (only when hooks haven't fired yet)
  return (args && args.session_id)
    || process.env.T2HELIX_SESSION_ID
    || ch.readCurrentSession()
    || 'mcp-session';
}

// Coerce a numeric-or-numeric-string arg to a finite number, else undefined.
// Fixes two boundary bugs: `|| default` clobbered an explicit 0, and JSON
// tooling that stringifies numbers ("0.8") silently dropped typeof-number
// filters in the data layer. undefined falls through to the documented default.
function num(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Minimal boundary validation: enforce each tool's declared `required` fields
// so a missing arg returns a structured InvalidParams (-32602) instead of a
// silent default / empty result that's hard to diagnose in a trusted memory layer.
function validateRequired(name, args) {
  const tool = TOOLS.find(t => t.name === name);
  const required = tool && tool.inputSchema && tool.inputSchema.required;
  if (!required) return;
  for (const field of required) {
    if (args[field] === undefined || args[field] === null) {
      const e = new Error(`invalid params: missing required field '${field}' for ${name}`);
      e.code = -32602;
      throw e;
    }
  }
}

function handleToolCall(name, args) {
  const sid = sessionId(args);
  validateRequired(name, args);
  switch (name) {
    case 'recall': {
      const hits = ch.recall({
        query: args.query,
        topK: num(args.topK) ?? 5,
        layer: args.layer,
        min_intensity: num(args.min_intensity),
        include_meta: args.include_meta || false,
        since: num(args.since),
        until: num(args.until),
        tag: args.tag
      });
      return textContent({ count: hits.length, hits });
    }
    case 'record': {
      const r = ch.record({
        session_id: sid,
        content: args.content,
        domain: args.domain,
        tags: args.tags,
        intensity: num(args.intensity),
        layer: args.layer
      });
      // record() returns {id:null, dropped:true} when the redact-or-drop
      // fail-safe fired — surface that as a failure, not a silent {ok:true,id:null}.
      if (r && r.dropped) return textContent({ ok: false, dropped: true, reason: 'write dropped: redaction failed' });
      return textContent({ ok: true, id: r.id });
    }
    case 'record_method': {
      const r = ch.recordMethod({
        session_id: sid,
        shape: args.shape,
        steps: args.steps,
        acceptance: args.acceptance,
        tool_classes: args.tool_classes,
        source: 'explicit'
      });
      if (r && r.dropped) return textContent({ ok: false, dropped: true, reason: 'write dropped: redaction failed' });
      return textContent({ ok: true, id: r.id, shape: args.shape });
    }
    case 'set_goal': {
      // Surface the chronicle result verbatim: it carries acceptance_criteria_count
      // and, when no boundary is defined, a lightweight (non-blocking) offer to
      // decompose the goal into acceptance_criteria (v0.3 step 3).
      const r = ch.setGoal({
        session_id: sid,
        goal: args.goal,
        why: args.why,
        acceptance_criteria: args.acceptance_criteria
      });
      return textContent(r);
    }
    case 'open_thread': {
      const r = ch.openThread({ question: args.question, domain: args.domain, context: args.context });
      return textContent({ ok: true, id: r.id });
    }
    case 'resolve_thread': {
      const r = ch.resolveThread({ id: args.id, resolution: args.resolution });
      return textContent(r);
    }
    case 'get_state': {
      return textContent(ch.getState(sid));
    }
    case 'recall_compass': {
      const entries = ch.getCompassHistory({
        limit: num(args.limit) ?? 20,
        classification: args.classification,
        matched_only: args.matched_only
      });
      return textContent({ count: entries.length, entries });
    }
    case 'confirm_pending': {
      const result = ch.approveConfirmation({ token: args.token });
      return textContent(result);
    }
    case 'list_pending': {
      const entries = ch.listPendingConfirmations({
        session_id: args.session_id,
        limit: num(args.limit) ?? 20
      });
      return textContent({ count: entries.length, entries });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function handleMessage(msg) {
  const { id, method, params } = msg || {};
  try {
    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
    }
    if (method === 'notifications/initialized') return null;
    if (method === 'tools/list') {
      return ok(id, { tools: TOOLS });
    }
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const result = handleToolCall(name, args);
      return ok(id, result);
    }
    if (method === 'ping') return ok(id, {});
    return err(id, -32601, `method not found: ${method}`);
  } catch (e) {
    // Honor a JSON-RPC code set on the error (e.g. -32602 from validateRequired);
    // otherwise surface a generic server error.
    const code = Number.isInteger(e.code) ? e.code : -32000;
    return err(id, code, e.message || String(e));
  }
}

// ── SSE transport ─────────────────────────────────────────────────────────────

function startSSE() {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

  // One SSEServerTransport per active SSE connection; keyed by sessionId.
  const transports = new Map();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/sse') {
      const mcpServer = new Server(SERVER_INFO, { capabilities: { tools: {} } });
      mcpServer.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
      mcpServer.setRequestHandler(CallToolRequestSchema, ({ params }) =>
        handleToolCall(params.name, params.arguments || {})
      );

      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => { transports.delete(transport.sessionId); };

      await mcpServer.connect(transport);

    } else if (req.method === 'POST' && url.pathname === '/messages') {
      const sid = url.searchParams.get('sessionId');
      const transport = transports.get(sid);
      if (!transport) { res.writeHead(400).end('Unknown sessionId'); return; }
      await transport.handlePostMessage(req, res);

    } else {
      res.writeHead(404).end('Not found');
    }
  });

  httpServer.listen(PORT, () => {
    process.stderr.write(`T2Helix MCP (SSE) listening on http://localhost:${PORT}/sse\n`);
  });

  const shutdown = () => {
    httpServer.close();
    try { ch.close(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── stdio transport (default, used by Claude Code plugin) ─────────────────────

function startStdio() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', line => {
    if (!line || !line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const reply = handleMessage(msg);
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  });
  rl.on('close', () => { try { ch.close(); } catch (_) {} process.exit(0); });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (TRANSPORT === 'sse') {
  startSSE();
} else {
  startStdio();
}
