#!/usr/bin/env node
'use strict';

/**
 * T2Helix Workflow Memory Monitor
 * Polls the Witness Relay server's workflow_memory.jsonl file via SSH,
 * and syncs any new entries into the T2Helix chronicle database.
 *
 * Usage: node monitor_workflow_memory.js
 *
 * Environment variables:
 *   T2HELIX_SYNC_INTERVAL   Poll interval in seconds (default: 5)
 *   JETSON_USER             SSH user for the relay host (default: jetson)
 *   JETSON_HOST             SSH host for the relay host (default: jetson.local)
 */

const { exec } = require('child_process');
const ch = require('../../lib/chronicle');

const POLL_INTERVAL_MS = (parseInt(process.env.T2HELIX_SYNC_INTERVAL, 10) || 5) * 1000;
// Set JETSON_USER / JETSON_HOST to point at your relay host. Placeholders below
// are intentionally generic so no private network detail ships in the repo.
const JETSON_USER = process.env.JETSON_USER || 'jetson';
const JETSON_HOST = process.env.JETSON_HOST || 'jetson.local';
const SSH_CMD = `ssh ${JETSON_USER}@${JETSON_HOST} "cat ~/witness_relay/workflow_memory.jsonl"`;

console.log(`T2Helix Workflow Memory Monitor started.`);
console.log(`Polling Jetson (${JETSON_USER}@${JETSON_HOST}) every ${POLL_INTERVAL_MS / 1000}s...\n`);

// Query T2Helix database directly to check if a specific epoch tag already exists
function checkEntryExists(epoch) {
  const db = ch.db();
  const tagToCheck = `epoch:${epoch}`;
  const row = db.prepare("SELECT id FROM insights WHERE tags LIKE ?").get(`%${tagToCheck}%`);
  return !!row;
}

// Fetch workflow memory from Jetson and sync it
function syncWorkflowMemory() {
  exec(SSH_CMD, (error, stdout, stderr) => {
    if (error) {
      console.warn(`[WR-SYNC-WARN] Failed to fetch workflow memory: ${error.message}`);
      return;
    }

    const lines = stdout.split('\n');
    let newEntriesCount = 0;

    // Get current session_id from chronicle
    let session_id = ch.readCurrentSession();
    if (!session_id) {
      // Find the latest goal's session_id as fallback
      const db = ch.db();
      const lastGoalRow = db.prepare("SELECT session_id FROM goals ORDER BY last_referenced DESC LIMIT 1").get();
      session_id = lastGoalRow ? lastGoalRow.session_id : 'witness-relay-sync';
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch (err) {
        console.warn(`[WR-SYNC-WARN] Ignored invalid JSON line: ${trimmed}`);
        continue;
      }

      const epoch = entry.epoch || entry.timestamp;
      if (!epoch) continue;

      // Check if already processed
      if (checkEntryExists(epoch)) {
        continue;
      }

      // Format chronicle content
      const content = 
        `[witness-relay-sync] Saved Workflow Step\n` +
        `Workflow Tag: ${entry.workflow || 'untagged'}\n` +
        `Question: ${entry.question || '(no question)'}\n` +
        `Answer:\n${entry.answer || '(no answer)'}\n` +
        `Screenshot: ${entry.screenshot || '(none)'}`;

      const tags = [
        "workflow-memory",
        "sync",
        `epoch:${epoch}`
      ];
      if (entry.workflow) {
        tags.push(`workflow:${entry.workflow}`);
      }

      try {
        const result = ch.record({
          session_id,
          content,
          domain: 'workflow-memory',
          tags,
          intensity: 0.8,
          layer: 'ground_truth'
        });

        console.log(`[WR-SYNC] Synced new entry (ID ${result.id}) from epoch ${epoch}`);
        newEntriesCount++;
      } catch (err) {
        console.error(`[WR-SYNC-ERROR] Failed to record chronicle entry: ${err.message}`);
      }
    }

    if (newEntriesCount > 0) {
      console.log(`[WR-SYNC] Completed sync: recorded ${newEntriesCount} new entries.\n`);
    }
  });
}

// Initial sync and poll setup
syncWorkflowMemory();
setInterval(syncWorkflowMemory, POLL_INTERVAL_MS);

