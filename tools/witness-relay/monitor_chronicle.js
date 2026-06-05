#!/usr/bin/env node
'use strict';

/**
 * T2Helix Chronicle Monitor
 * Watches for new entries and surfaces them for Grok + Antigravity.
 *
 * Usage: node monitor_chronicle.js
 *
 * Environment variables:
 *   T2HELIX_MONITOR_INTERVAL   Poll interval in seconds (default: 4)
 *   T2HELIX_MONITOR_DOMAIN     Only show entries from this domain
 *   T2HELIX_MONITOR_TAG        Only show entries containing this tag
 *
 * On startup, the monitor looks back 24 hours by default to avoid missing entries
 * after downtime or restarts.
 *
 * If you get a native module error, run once:
 *   cd ~/t2helix && npm rebuild better-sqlite3
 */

const POLL_INTERVAL_MS = (parseInt(process.env.T2HELIX_MONITOR_INTERVAL, 10) || 4) * 1000;
const FILTER_DOMAIN = process.env.T2HELIX_MONITOR_DOMAIN || null;
const FILTER_TAG = process.env.T2HELIX_MONITOR_TAG || null;

let lastTimestamp = Date.now() - (1000 * 60 * 60 * 24); // start looking back 24 hours
let pollCount = 0;

function formatEvent(entry) {
  const header = `--- NEW CHRONICLE ENTRY (ID ${entry.id}) ---`;
  const meta = `Layer: ${entry.layer || 'hypothesis'} | Domain: ${entry.domain || '—'} | Tags: ${(entry.tags || []).join(', ') || '—'}`;
  const content = entry.content.length > 600 ? entry.content.slice(0, 600) + '…' : entry.content;

  return `${header}\n${meta}\n${content}\n`;
}

function emitJSONL(entry) {
  const event = {
    type: 'chronicle.new_entry',
    id: entry.id,
    timestamp: entry.created_at,
    layer: entry.layer,
    domain: entry.domain,
    tags: entry.tags || [],
    content: entry.content
  };
  process.stdout.write(JSON.stringify(event) + '\n');
}

async function checkForNewEntries() {
  pollCount++;
  try {
    const Database = require('better-sqlite3');
    const path = require('path');
    const dbPath = path.join(process.env.T2HELIX_DATA_DIR || path.join(process.env.HOME, '.t2helix-data'), 'chronicle.db');
    const db = new Database(dbPath, { readonly: true });

    const stmt = db.prepare(`
      SELECT id, created_at, layer, domain, tags, content
      FROM insights
      WHERE created_at > ?
      ORDER BY created_at ASC
      LIMIT 50
    `);

    const rows = stmt.all(lastTimestamp);
    db.close();

    if (pollCount % 3 === 0) {
      console.log(`[monitor] poll #${pollCount} - checked ${rows ? rows.length : 0} candidates, last=${new Date(lastTimestamp).toISOString().slice(11,19)}`);
    }

    if (!rows || rows.length === 0) return;

    for (const row of rows) {
      const entry = {
        id: row.id,
        created_at: row.created_at,
        layer: row.layer,
        domain: row.domain,
        tags: row.tags ? JSON.parse(row.tags) : [],
        content: row.content
      };

      if (FILTER_DOMAIN && entry.domain !== FILTER_DOMAIN) continue;
      if (FILTER_TAG && !entry.tags.includes(FILTER_TAG)) continue;

      console.log(formatEvent(entry));
      emitJSONL(entry);

      // delivery log only — no auto-reply
      if (entry.tags.includes('to:grok') || entry.content.includes('PING_TO_GROK_LOOP_TEST')) {
        console.log(`[delivery] to:grok message received (entry ${entry.id}) — awaiting Grok response`);
      }

      lastTimestamp = Math.max(lastTimestamp, entry.created_at);
    }
  } catch (err) {
    console.error('monitor error:', err.message);
  }
}

const filters = [];
if (FILTER_DOMAIN) filters.push(`domain=${FILTER_DOMAIN}`);
if (FILTER_TAG) filters.push(`tag=${FILTER_TAG}`);
const filterMsg = filters.length ? ` (filters: ${filters.join(', ')})` : '';

console.log(`T2Helix Chronicle Monitor started. Polling every ${POLL_INTERVAL_MS / 1000}s${filterMsg}\n`);

setInterval(checkForNewEntries, POLL_INTERVAL_MS);
checkForNewEntries(); // initial check
