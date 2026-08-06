'use strict';

/**
 * better-sqlite3 ABI surface for T2Helix.
 *
 * Root landmine (2026-08): `require('better-sqlite3')` only loads the JS
 * wrapper. The native `.node` is dlopened inside `new Database(...)`.
 * So a driver "load" that only requires the package reports GREEN under the
 * wrong Node ABI, and MCP `initialize`/`tools/list` look healthy until the
 * first chronicle op. Force a `:memory:` open for any truth-bearing probe.
 *
 * Stamp file (`.native-abi.json` at package root) records which Node built
 * the binding so mcp-launch / doctor can re-exec or tell the operator to
 * rebuild under a specific binary.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const STAMP_NAME = '.native-abi.json';

function packageRoot() {
  return PACKAGE_ROOT;
}

function stampPath(root = PACKAGE_ROOT) {
  return path.join(root, STAMP_NAME);
}

function currentAbi() {
  return {
    modules: String(process.versions.modules),
    node: process.version,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch
  };
}

function readStamp(root = PACKAGE_ROOT) {
  try {
    const raw = fs.readFileSync(stampPath(root), 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    return j;
  } catch {
    return null;
  }
}

function writeStamp(root = PACKAGE_ROOT, extra = {}) {
  const body = {
    ...currentAbi(),
    builtAt: new Date().toISOString(),
    ...extra
  };
  const target = stampPath(root);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
  return body;
}

/**
 * Probe whether better-sqlite3 can actually open a DB under this process.
 * Returns { ok, error, code, modules }.
 */
function probeBinding() {
  const modules = String(process.versions.modules);
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    try {
      db.prepare('SELECT 1 AS x').get();
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
    return { ok: true, error: null, code: null, modules };
  } catch (e) {
    return {
      ok: false,
      error: e && e.message ? String(e.message) : String(e),
      code: e && e.code ? e.code : 'T2HELIX_DRIVER_UNAVAILABLE',
      modules
    };
  }
}

/**
 * Build the actionable error operators see when the native binding fails.
 */
function driverUnavailableError(cause) {
  const abi = currentAbi();
  const stamp = readStamp();
  const parts = [
    `t2helix: SQLite native binding unavailable under ${abi.execPath} ` +
      `(Node ${abi.node}, ABI ${abi.modules})`
  ];
  if (cause && cause.message) {
    parts.push(`cause: ${cause.message.split('\n')[0]}`);
  }
  if (stamp && stamp.modules && String(stamp.modules) !== abi.modules) {
    parts.push(
      `binding stamp ABI ${stamp.modules} (built ${stamp.node || '?'} at ` +
        `${stamp.execPath || '?'}) ≠ current ABI ${abi.modules}`
    );
  }
  parts.push(
    `remedy: cd ${PACKAGE_ROOT} && npm run rebuild` +
      (stamp && stamp.execPath && stamp.execPath !== abi.execPath
        ? `  # or launch MCP with the stamped node: ${stamp.execPath}`
        : '  # rebuilds better-sqlite3 for THIS node and rewrites .native-abi.json')
  );
  const err = new Error(parts.join(' — '));
  err.code = 'T2HELIX_DRIVER_UNAVAILABLE';
  err.cause = cause;
  err.abi = abi;
  err.stamp = stamp;
  return err;
}

/**
 * Candidate Node binaries that may match the installed better-sqlite3.
 * Order: stamp → current → hermes node → nvm majors → PATH node.
 */
function candidateNodeBinaries(root = PACKAGE_ROOT) {
  const home = os.homedir();
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };

  const stamp = readStamp(root);
  if (stamp && stamp.execPath) push(stamp.execPath);
  push(process.execPath);

  push(path.join(home, '.hermes', 'node', 'bin', 'node'));
  push(path.join(home, '.local', 'bin', 'node'));

  // nvm: prefer 22 then 20 then 24 (binding on this machine is often 22)
  const nvmRoot = process.env.NVM_DIR || path.join(home, '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvmRoot).sort().reverse();
    const prefer = (v) => {
      if (v.startsWith('v22')) return 0;
      if (v.startsWith('v20')) return 1;
      if (v.startsWith('v24')) return 2;
      return 3;
    };
    versions.sort((a, b) => prefer(a) - prefer(b) || b.localeCompare(a));
    for (const v of versions) {
      push(path.join(nvmRoot, v, 'bin', 'node'));
    }
  } catch { /* no nvm */ }

  // which node via PATH — last resort (often the wrong one)
  try {
    const which = spawnSync('which', ['node'], { encoding: 'utf8' });
    if (which.status === 0) push(which.stdout.trim());
  } catch { /* ignore */ }

  return out.filter((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Probe a *specific* node binary against this package's better-sqlite3.
 * Spawns a short-lived child so we never pollute the parent process state.
 */
function probeUnderNode(nodePath, root = PACKAGE_ROOT) {
  if (!nodePath) return { ok: false, error: 'no node path' };
  const script = [
    "const Database=require('better-sqlite3');",
    "const db=new Database(':memory:');",
    "db.prepare('SELECT 1').get();",
    'db.close();',
    "process.stdout.write('ok');"
  ].join('');
  const r = spawnSync(nodePath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15000
  });
  if (r.status === 0 && /ok/.test(r.stdout || '')) {
    return { ok: true, error: null, nodePath };
  }
  const err = (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n')[0];
  return { ok: false, error: err, nodePath };
}

/**
 * Find a node binary that can load this package's better-sqlite3.
 * Returns absolute path or null.
 */
function findCompatibleNode(root = PACKAGE_ROOT) {
  // Fast path: current process already works
  if (probeBinding().ok) return process.execPath;

  for (const candidate of candidateNodeBinaries(root)) {
    if (candidate === process.execPath) continue; // already failed
    const r = probeUnderNode(candidate, root);
    if (r.ok) return candidate;
  }
  return null;
}

/**
 * Human-readable rebuild / pin advice for doctor + MCP launch.
 */
function remedyText(probe = null, root = PACKAGE_ROOT) {
  const abi = currentAbi();
  const stamp = readStamp(root);
  const lines = [
    `Run: cd ${root} && npm run rebuild`,
    `(rebuilds better-sqlite3 for the node that runs the command, then writes ${STAMP_NAME}.)`
  ];
  if (stamp && stamp.execPath) {
    lines.push(`Last successful build node: ${stamp.execPath} (${stamp.node}, ABI ${stamp.modules})`);
  }
  if (probe && !probe.ok && probe.error) {
    lines.push(`Probe error: ${probe.error.split('\n')[0]}`);
  }
  lines.push(
    `Current node: ${abi.execPath} (${abi.node}, ABI ${abi.modules})`
  );
  return lines.join(' ');
}

module.exports = {
  STAMP_NAME,
  packageRoot,
  stampPath,
  currentAbi,
  readStamp,
  writeStamp,
  probeBinding,
  driverUnavailableError,
  candidateNodeBinaries,
  probeUnderNode,
  findCompatibleNode,
  remedyText
};
