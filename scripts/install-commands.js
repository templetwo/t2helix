#!/usr/bin/env node
'use strict';

// scripts/install-commands.js — install T2Helix slash commands into the
// Claude Code user command directory (~/.claude/commands/t2helix/).
//
// Usage:
//   node scripts/install-commands.js [--uninstall]
//
// After running, the commands are available as:
//   /t2helix:audit-queue
//   /t2helix:promote-method <id>
//   /t2helix:dismiss-method <id>
//   /t2helix:recall-audit [WITNESS|PAUSE]
//   /t2helix:recall-method <query>

const fs = require('fs');
const path = require('path');
const os = require('os');

const COMMANDS_SRC = path.join(__dirname, '..', 'commands');
const COMMANDS_DEST = path.join(os.homedir(), '.claude', 'commands', 't2helix');

const uninstall = process.argv.includes('--uninstall');

if (uninstall) {
  if (fs.existsSync(COMMANDS_DEST)) {
    fs.rmSync(COMMANDS_DEST, { recursive: true, force: true });
    process.stdout.write(`Removed ${COMMANDS_DEST}\n`);
  } else {
    process.stdout.write(`Nothing to remove (${COMMANDS_DEST} does not exist)\n`);
  }
  process.exit(0);
}

// Create destination directory
fs.mkdirSync(COMMANDS_DEST, { recursive: true });

const files = fs.readdirSync(COMMANDS_SRC).filter(f => f.endsWith('.md'));
if (files.length === 0) {
  process.stderr.write('No .md files found in commands/\n');
  process.exit(1);
}

for (const file of files) {
  const src = path.join(COMMANDS_SRC, file);
  const dest = path.join(COMMANDS_DEST, file);
  fs.copyFileSync(src, dest);
  const cmdName = path.basename(file, '.md');
  process.stdout.write(`  installed /t2helix:${cmdName}\n`);
}

process.stdout.write(`\n${files.length} command(s) installed to ${COMMANDS_DEST}\n`);
process.stdout.write('Commands are now available in Claude Code as /t2helix:<name>\n');
