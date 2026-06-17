#!/usr/bin/env node
'use strict';

// scripts/release-doctor.js — verify the project's PROSE claims (README, docs)
// against its MACHINE-READABLE sources of truth (package.json, the live MCP tool
// registry, the hook files, the CHANGELOG, the test runner). Sibling to
// scripts/doctor.js — that one probes the live native binding / DB health; this
// one catches STALE DOCS: a version that lags, a tool/hook/test count that drifted,
// a Node range that no longer matches engines, an undocumented shipped feature.
//
// Exits 0 only when every hard check passes; non-zero (with a per-check report) on
// any drift. INFO / advisory lines never fail the run.
//
// Usage:
//   npm run release:doctor            # full — runs the suite to get the live test total
//   npm run release:doctor -- --quick # skip the live test-count check (fast, static only)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const QUICK = process.argv.slice(2).includes('--quick');

function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; } }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

const pkg = JSON.parse(read('package.json'));
const readme = read('README.md') || '';
const changelog = read('CHANGELOG.md') || '';

// ── small helpers ──────────────────────────────────────────────────────────────
const WORD = { zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,
  ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,
  seventeen:17,eighteen:18,nineteen:19,twenty:20 };

// Every count claimed before a unit word, e.g. "thirteen tools" / "5 hooks" → numbers.
function claimedCounts(text, unit) {
  const out = [];
  const re = new RegExp('\\b(\\d+|' + Object.keys(WORD).join('|') + ')\\s+' + unit + '\\b', 'gi');
  let m; while ((m = re.exec(text))) { const t = m[1].toLowerCase(); out.push(/^\d+$/.test(t) ? +t : WORD[t]); }
  return out;
}
function semver(s) { const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(s); return m ? [+m[1], +m[2], +(m[3] || 0)] : null; }
function cmpSemver(a, b) { for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); } return 0; }
function maxReadmeVersion(text) {
  // Require a `v` prefix so license/SPDX tokens ("Apache-2.0") and dates aren't
  // misread as a documented release version. The README writes its changelog
  // narrative as v0.4.0 / v0.3.0 / … so the v-prefixed max IS the newest version
  // the README claims to document.
  const re = /\bv(\d+)\.(\d+)(?:\.(\d+))?\b/g; let m, best = null;
  while ((m = re.exec(text))) {
    const v = [+m[1], +m[2], +(m[3] || 0)];
    if (v[0] > 50) continue;                       // skip year-like / port-like noise
    if (!best || cmpSemver(v, best) > 0) best = v;
  }
  return best;
}

// MCP tool count from the TOOLS registry in mcp/server.js, read STATICALLY (not by
// spawning the server). The stdio server exits on stdin-close via process.exit(0),
// which can truncate the final tools/list response over a one-shot pipe — harmless
// for the host (its stdin stays open the whole session) but flaky for a one-shot
// probe like a doctor. The TOOLS array IS the registry; each tool object declares
// `name:` at 4-space indent (SERVER_INFO.name does not), so an indent-anchored scan
// is deterministic and side-effect-free.
function declaredToolNames() {
  const src = read('mcp/server.js') || '';
  if (!/const TOOLS = \[/.test(src)) throw new Error('TOOLS registry not found in mcp/server.js');
  const names = [...src.matchAll(/^\s{4}name:\s*'([a-z_0-9]+)'/gm)].map(m => m[1]);
  if (!names.length) throw new Error('no tool names parsed from the TOOLS registry');
  return names;
}

// Live test total: run the suite, sum every "N passed". Skipped under --quick.
function liveTestTotal() {
  const r = spawnSync('npm', ['test'], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+)\s+passed/g) || [];
  const total = m.reduce((a, s) => a + parseInt(s, 10), 0);
  return { total, suiteOk: r.status === 0, ran: m.length };
}

// ── run the checks ───────────────────────────────────────────────────────────
const checks = [];   // { name, status: 'PASS'|'FAIL'|'INFO', detail }
function pass(name, detail) { checks.push({ name, status: 'PASS', detail }); }
function fail(name, detail) { checks.push({ name, status: 'FAIL', detail }); }
function info(name, detail) { checks.push({ name, status: 'INFO', detail }); }

// 1. package.version == CHANGELOG latest [version]
(() => {
  const clVer = (changelog.match(/^##\s*\[([0-9]+\.[0-9]+\.[0-9]+)\]/m) || [])[1];
  if (!clVer) return fail('changelog ↔ package version', 'no "## [x.y.z]" heading found in CHANGELOG.md');
  if (clVer === pkg.version) pass('changelog ↔ package version', `both ${pkg.version}`);
  else fail('changelog ↔ package version', `CHANGELOG latest is [${clVer}] but package.json is ${pkg.version}`);
})();

// 2. README documents the current version (does not lag package.version)
(() => {
  const rv = maxReadmeVersion(readme);
  const pv = semver(pkg.version);
  if (!rv) return info('README version currency', `README declares no version token; package is ${pkg.version}`);
  if (cmpSemver(rv, pv) >= 0) pass('README version currency', `README documents up to v${rv.join('.')} ≥ package ${pkg.version}`);
  else fail('README version currency', `README's newest documented version is v${rv.join('.')} but package is ${pkg.version} — README lags`);
})();

// 3. README tool count == live MCP registry
(() => {
  let names; try { names = declaredToolNames(); } catch (e) { return fail('README tool count', e.message); }
  const actual = names.length;
  const claims = [...new Set(claimedCounts(readme, 'tools'))];
  if (!claims.length) return info('README tool count', `MCP registry exposes ${actual} tools; README states no "<n> tools" count`);
  if (claims.includes(actual)) {
    const others = claims.filter(c => c !== actual);
    if (others.length) info('README tool count', `current ${actual} present; README also mentions ${others.join('/')} tools (older/contextual — verify not a stale headline)`);
    else pass('README tool count', `README says ${actual} tools, registry exposes ${actual}`);
  } else fail('README tool count', `registry exposes ${actual} tools, README's count claim(s) ${claims.join('/')} include no current match`);
})();

// 4. README hook count includes the real total (advisory on any other count)
(() => {
  const hookFiles = fs.readdirSync(path.join(ROOT, 'hooks')).filter(f => f.endsWith('.js'));
  const hooksJson = JSON.parse(read('hooks/hooks.json'));
  const events = Object.keys(hooksJson.hooks || {}).length;
  const actual = hookFiles.length;
  if (actual !== events) return fail('hook count consistency', `${actual} hook .js files but hooks.json registers ${events} events`);
  const claims = [...new Set(claimedCounts(readme, 'hooks'))];
  if (claims.includes(actual)) {
    const others = claims.filter(c => c !== actual);
    if (others.length) info('README hook count', `total ${actual} present; README also mentions ${others.join('/')} hooks (verify these describe a subset, not a stale total)`);
    else pass('README hook count', `README says ${actual} hooks, repo has ${actual} (files + registered events)`);
  } else if (!claims.length) info('README hook count', `repo has ${actual} hooks; README states no "<n> hooks" count`);
  else fail('README hook count', `repo has ${actual} hooks, README claims ${claims.join('/')} (no matching total)`);
})();

// 5. README test count == live suite total (or non-brittle wording)
(() => {
  const m = /(\d+)\s+tests?\s+total/i.exec(readme);
  if (!m) return pass('README test count', 'README uses non-brittle wording (no hardcoded "<n> tests total")');
  const claimed = +m[1];
  if (QUICK) return info('README test count', `README hardcodes "${claimed} tests total" — re-run without --quick to verify against the suite`);
  const { total, suiteOk, ran } = liveTestTotal();
  if (!ran) return fail('README test count', 'could not parse a test total from `npm test` output');
  if (!suiteOk) info('README test count', `note: \`npm test\` did not exit 0 while counting`);
  if (claimed === total) pass('README test count', `README says ${claimed} tests total, suite reports ${total}`);
  else fail('README test count', `README hardcodes "${claimed} tests total" but the suite reports ${total} — stale, or reword non-brittly`);
})();

// 6. README Node range == package engines
(() => {
  const eng = (pkg.engines && pkg.engines.node) || '';
  const lo = (eng.match(/>=\s*(\d+)/) || [])[1];
  const hiExcl = (eng.match(/<\s*(\d+)/) || [])[1];
  if (!lo || !hiExcl) return info('README Node range', `package engines.node = "${eng}" (no >=lo <hi form to compare)`);
  const expected = [+lo, +hiExcl - 1];
  const rm = readme.match(/Node\s*(\d+)\s*[–-]\s*(\d+)/i);
  if (!rm) return fail('README Node range', `engines say Node ${expected[0]}–${expected[1]}; README states no matching "Node lo–hi" range`);
  const got = [+rm[1], +rm[2]];
  if (got[0] === expected[0] && got[1] === expected[1]) pass('README Node range', `README says Node ${got[0]}–${got[1]}, engines "${eng}" agree`);
  else fail('README Node range', `engines "${eng}" → Node ${expected[0]}–${expected[1]}, README says ${got[0]}–${got[1]}`);
})();

// 7. A shipped feature is documented: the error-atlas loader (v0.10.0)
(() => {
  const implemented = exists('lib/atlas.js') && exists('scripts/import-atlas.js');
  if (!implemented) return info('error-atlas documented', 'loader not present — nothing to document');
  const inDocs = exists('docs/error-atlas.md');
  const inReadme = /error[- ]?atlas|import-atlas/i.test(readme);
  if (inDocs || inReadme) {
    const note = inReadme ? '' : ' (in docs/error-atlas.md; README does not yet mention it)';
    pass('error-atlas documented', `loader is implemented and documented${note}`);
  } else fail('error-atlas documented', 'loader is implemented but neither README nor docs/error-atlas.md mentions it');
})();

// 8. Plugin manifest version field (single-source-of-truth observation)
(() => {
  const files = ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'].filter(exists);
  const withVersion = files.filter(f => { try { return 'version' in JSON.parse(read(f)); } catch { return false; } });
  if (withVersion.length) {
    const mismatch = withVersion.filter(f => JSON.parse(read(f)).version !== pkg.version);
    if (mismatch.length) fail('manifest ↔ package version', `${mismatch.join(', ')} version ≠ package ${pkg.version}`);
    else pass('manifest ↔ package version', `manifest version matches package ${pkg.version}`);
  } else {
    info('manifest version field', `no version field in ${files.map(f => path.basename(f)).join(' / ')} — package.json is the only machine-readable version source (see release-truth thread)`);
  }
})();

// ── report ───────────────────────────────────────────────────────────────────
const ICON = { PASS: '  PASS  ', FAIL: '  FAIL  ', INFO: '  info  ' };
console.log('T2Helix Release-Truth Doctor');
console.log('');
console.log(`  package : ${pkg.name} ${pkg.version}  (Node ${pkg.engines && pkg.engines.node})`);
console.log('');
for (const c of checks) {
  console.log(`  [${ICON[c.status]}]  ${c.name}`);
  console.log(`            ${c.detail}`);
}
console.log('');
const failed = checks.filter(c => c.status === 'FAIL');
if (failed.length) {
  console.log(`STATUS: DRIFT — ${failed.length} stale claim(s) to reconcile: ${failed.map(c => c.name).join('; ')}.`);
  process.exit(1);
} else {
  console.log('STATUS: TRUE — every checked claim matches its machine-readable source.');
  process.exit(0);
}
