'use strict';

const MANIFEST_VERSION = '1.0';
const AUDIT_SCHEMA_VERSION = '1.0';

// Build a portable manifest from the current chronicle + loaded compass rules.
// Returns a plain object — caller decides how to serialize / write it.
function buildManifest() {
  const ch = require('./chronicle');
  const { loadRules } = require('./compass');

  const rules = loadRules().map(r => {
    const out = { id: r.id, classification: r.classification };
    if (r.reason) out.reason = r.reason;
    if (r.tool) out.tool = r.tool;
    if (r.condition) out.condition = r.condition;
    if (r.pattern_source) out.pattern_source = r.pattern_source;
    else if (r.pattern) out.pattern = r.pattern;
    if (r._source) out._source = r._source;
    return out;
  });

  const promoted_methods = ch.getMethodInsights();

  return {
    manifest_version: MANIFEST_VERSION,
    t2helix_version: require('../package.json').version,
    created_at: new Date().toISOString(),
    rules,
    promoted_methods,
    audit_schema_version: AUDIT_SCHEMA_VERSION
  };
}

// Validate a manifest object. Returns null if valid, or an error string.
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'manifest must be a JSON object';
  if (manifest.manifest_version !== MANIFEST_VERSION) {
    return `unsupported manifest_version: ${manifest.manifest_version} (expected ${MANIFEST_VERSION})`;
  }
  if (!Array.isArray(manifest.promoted_methods)) return 'promoted_methods must be an array';
  if (!Array.isArray(manifest.rules)) return 'rules must be an array';
  return null;
}

// Import promoted_methods from a manifest into the current chronicle.
// Skips methods whose content already exists (content-equality dedup).
// Returns { imported, skipped, errors[] }.
function importManifest(manifest, { dryRun = false } = {}) {
  const err = validateManifest(manifest);
  if (err) throw new Error(`importManifest: ${err}`);

  const ch = require('./chronicle');
  const SESSION_ID = 'manifest-import';

  const existing = ch.getMethodInsights();
  const existingContent = new Set(existing.map(m => m.content));

  let imported = 0, skipped = 0;
  const errors = [];

  for (const m of manifest.promoted_methods) {
    if (existingContent.has(m.content)) { skipped++; continue; }
    if (dryRun) { imported++; continue; }
    try {
      ch.record({
        session_id: SESSION_ID,
        content: m.content,
        domain: 'method',
        tags: m.tags || [],
        layer: 'ground_truth'
      });
      imported++;
    } catch (e) {
      errors.push({ method_id: m.id, error: e.message });
    }
  }

  return { imported, skipped, errors };
}

module.exports = { buildManifest, importManifest, validateManifest, MANIFEST_VERSION, AUDIT_SCHEMA_VERSION };
