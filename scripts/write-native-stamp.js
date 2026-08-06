#!/usr/bin/env node
'use strict';

// Write .native-abi.json after a successful better-sqlite3 rebuild/install.
// Also refuses to stamp if the binding cannot open :memory: under this node.

const native = require('../lib/native-binding');

const probe = native.probeBinding();
if (!probe.ok) {
  process.stderr.write(
    `[t2helix] cannot write native stamp — binding probe failed under ${process.execPath}\n` +
      `${probe.error || ''}\n` +
      `${native.remedyText(probe)}\n`
  );
  process.exit(1);
}

const stamp = native.writeStamp();
process.stdout.write(
  `[t2helix] native stamp written: ABI ${stamp.modules} · ${stamp.node} · ${stamp.execPath}\n`
);
process.exit(0);
