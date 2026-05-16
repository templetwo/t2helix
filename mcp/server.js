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
    name: 'set_goal',
    description: 'Define or update the current session goal. Anchors subsequent work.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        why: { type: 'string' },
        acceptance_criteria: { type: 'array', items: { type: 'string' } }
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

function handleToolCall(name, args) {
  const sid = sessionId(args);
  switch (name) {
    case 'recall': {
      const hits = ch.recall({
        query: args.query,
        topK: args.topK || 5,
        layer: args.layer,
        min_intensity: args.min_intensity,
        include_meta: args.include_meta || false
      });
      return textContent({ count: hits.length, hits });
    }
    case 'record': {
      const r = ch.record({
        session_id: sid,
        content: args.content,
        domain: args.domain,
        tags: args.tags,
        intensity: args.intensity,
        layer: args.layer
      });
      return textContent({ ok: true, id: r.id });
    }
    case 'set_goal': {
      ch.setGoal({
        session_id: sid,
        goal: args.goal,
        why: args.why,
        acceptance_criteria: args.acceptance_criteria
      });
      return textContent({ ok: true });
    }
    case 'open_thread': {
      const r = ch.openThread({ question: args.question, domain: args.domain, context: args.context });
      return textContent({ ok: true, id: r.id });
    }
    case 'get_state': {
      return textContent(ch.getState(sid));
    }
    case 'recall_compass': {
      const entries = ch.getCompassHistory({
        limit: args.limit || 20,
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
        limit: args.limit || 20
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
    return err(id, -32000, e.message || String(e));
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
