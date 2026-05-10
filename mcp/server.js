#!/usr/bin/env node
'use strict';

const readline = require('readline');
const ch = require('../lib/chronicle');

const SERVER_INFO = { name: 't2helix', version: '0.0.1' };

const TOOLS = [
  {
    name: 'recall',
    description: 'Search the local T2Helix chronicle for past insights related to a query. Use before tackling non-trivial coding work.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms — short, content-heavy phrases work best.' },
        topK: { type: 'number', default: 5 }
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
  return (args && args.session_id) || process.env.T2HELIX_SESSION_ID || 'mcp-session';
}

function handleToolCall(name, args) {
  const sid = sessionId(args);
  switch (name) {
    case 'recall': {
      const hits = ch.recall({ query: args.query, topK: args.topK || 5 });
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

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', line => {
    if (!line || !line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const reply = handleMessage(msg);
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  });
  rl.on('close', () => { try { ch.close(); } catch (_) {} process.exit(0); });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

main();
