#!/usr/bin/env node
'use strict';

// dashboard/server.js — T2Helix real-time dashboard (v0.9.0).
//
// Standalone HTTP server on port 3743. Polls compass_log for new rows every
// 2 seconds and pushes them to connected browsers over SSE. Zero hook changes —
// it reads the same chronicle.db the hooks write to.
//
// Routes:
//   GET /            → dashboard/public/index.html
//   GET /events      → SSE stream (compass_log tail, cursor-based)
//   GET /api/state   → JSON { goal, open_threads, recent_insights }
//   GET /api/candidates → JSON { candidates: [...] }
//
// Usage:
//   node dashboard/server.js [--port 3743]
//   npm run dashboard

const http = require('http');
const fs = require('fs');
const path = require('path');
const ch = require('../lib/chronicle');

const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
}
const PORT = parseInt(argValue('--port') || process.env.T2HELIX_DASHBOARD_PORT || '3743', 10);
const POLL_MS = 2000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const HTML_FILE = path.join(PUBLIC_DIR, 'index.html');

// ── SSE client registry ───────────────────────────────────────────────────────

const sseClients = new Set();

function sendToAll(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

// ── DB tail-polling ───────────────────────────────────────────────────────────

let lastSeenId = 0;

function pollCompass() {
  if (sseClients.size === 0) return; // no listeners — skip the DB read
  try {
    const rows = ch.getCompassSince({ since_id: lastSeenId, limit: 50 });
    if (rows.length > 0) {
      lastSeenId = rows[rows.length - 1].id;
      for (const row of rows) {
        sendToAll('compass', row);
      }
    }
  } catch (_) {
    // fail-open: a DB read error during polling doesn't crash the dashboard
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  // Static dashboard page
  if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'"
      });
      res.end(html);
    } catch (e) {
      res.writeHead(500).end(`Dashboard page not found: ${e.message}`);
    }
    return;
  }

  // SSE stream
  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(':\n\n'); // comment to establish the connection
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));

    // Send last 50 entries immediately on connect so the page has history
    try {
      const recent = ch.getCompassSince({ since_id: Math.max(0, lastSeenId - 200), limit: 50 });
      for (const row of recent) {
        res.write(`event: compass\ndata: ${JSON.stringify(row)}\n\n`);
      }
    } catch (_) {}
    return;
  }

  // API: current session state
  if (req.method === 'GET' && pathname === '/api/state') {
    try {
      const sessionId = ch.readCurrentSession();
      const state = sessionId ? ch.getState(sessionId) : { goal: null, open_threads: [], recent_insights: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: method candidates
  if (req.method === 'GET' && pathname === '/api/candidates') {
    try {
      const candidates = ch.listMethodCandidates({ limit: 50 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ candidates }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404).end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const actualPort = server.address().port;
  process.stderr.write(`T2Helix dashboard listening on http://localhost:${actualPort}\n`);
  process.stdout.write(`Open http://localhost:${actualPort} in your browser\n`);
  // Initialize lastSeenId to the current max row so we only tail NEW rows
  try {
    const rows = ch.getCompassSince({ since_id: 0, limit: 1 });
    if (rows.length === 0) {
      try {
        const last = ch.db().prepare('SELECT MAX(id) as m FROM compass_log').get();
        lastSeenId = last?.m || 0;
      } catch (_) {}
    }
  } catch (_) {}
  setInterval(pollCompass, POLL_MS);
});

const shutdown = () => {
  server.close();
  try { ch.close(); } catch (_) {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
