'use strict';

// Safe-repeat leases: session-scoped, TTL-bounded permission to repeat one
// exact normalized action after human confirmation. Never overrides WITNESS.

const crypto = require('crypto');

const DEFAULT_TTL_MS = 20 * 60 * 1000; // 20 minutes
const DEFAULT_MAX_USES = 10;
const PARSER_VERSION = 'action-ir/0.12.0';

function newLeaseId() {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * @param {object} db - better-sqlite3 connection (or prepared-via chronicle)
 * @param {object} opts
 */
function armLease(db, {
  session_id,
  normalized_action_hash,
  executable,
  cwd,
  parser_version,
  max_uses,
  ttl_ms,
  classification_ceiling,
  issued_from_compass_log_id
}) {
  if (!session_id) throw new Error('armLease: session_id required');
  if (!normalized_action_hash) throw new Error('armLease: normalized_action_hash required');
  if (!executable) throw new Error('armLease: executable required');

  const now = Date.now();
  const lease_id = newLeaseId();
  const expires_at = now + (typeof ttl_ms === 'number' ? ttl_ms : DEFAULT_TTL_MS);
  const maxUses = typeof max_uses === 'number' ? max_uses : DEFAULT_MAX_USES;
  const ceiling = classification_ceiling || 'PAUSE';
  if (ceiling === 'WITNESS') {
    throw new Error('armLease: classification_ceiling cannot be WITNESS (immutable floor)');
  }

  db.prepare(`
    INSERT INTO safe_repeat_leases (
      lease_id, session_id, normalized_action_hash, executable, cwd,
      parser_version, expires_at, max_uses, uses_count, classification_ceiling,
      issued_from_compass_log_id, revoked_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?)
  `).run(
    lease_id,
    session_id,
    normalized_action_hash,
    executable,
    cwd || '',
    parser_version || PARSER_VERSION,
    expires_at,
    maxUses,
    ceiling,
    issued_from_compass_log_id || null,
    now
  );

  return { lease_id, expires_at, max_uses: maxUses, normalized_action_hash };
}

/**
 * Find a usable lease for this session + semantic identity.
 * Returns the row or null.
 */
function findActiveLease(db, {
  session_id,
  normalized_action_hash,
  parser_version,
  cwd
}) {
  if (!session_id || !normalized_action_hash) return null;
  const now = Date.now();
  const row = db.prepare(`
    SELECT * FROM safe_repeat_leases
    WHERE session_id = ?
      AND normalized_action_hash = ?
      AND parser_version = ?
      AND cwd = ?
      AND revoked_at IS NULL
      AND expires_at > ?
      AND uses_count < max_uses
    ORDER BY created_at DESC
    LIMIT 1
  `).get(
    session_id,
    normalized_action_hash,
    parser_version || PARSER_VERSION,
    cwd || '',
    now
  );
  return row || null;
}

/**
 * Atomically consume one use. Returns true if claimed.
 */
function consumeLease(db, lease_id) {
  const now = Date.now();
  const info = db.prepare(`
    UPDATE safe_repeat_leases
    SET uses_count = uses_count + 1
    WHERE lease_id = ?
      AND revoked_at IS NULL
      AND expires_at > ?
      AND uses_count < max_uses
  `).run(lease_id, now);
  return info.changes === 1;
}

function revokeLease(db, { lease_id, session_id, all } = {}) {
  const now = Date.now();
  if (all && session_id) {
    const info = db.prepare(`
      UPDATE safe_repeat_leases
      SET revoked_at = ?
      WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ?
    `).run(now, session_id, now);
    return { ok: true, revoked: info.changes };
  }
  if (!lease_id) return { ok: false, error: 'lease_id required (or all=true with session_id)' };
  const info = db.prepare(`
    UPDATE safe_repeat_leases
    SET revoked_at = ?
    WHERE lease_id = ? AND revoked_at IS NULL
  `).run(now, lease_id);
  if (info.changes !== 1) return { ok: false, error: 'lease not found or already revoked' };
  return { ok: true, revoked: 1, lease_id };
}

function listLeases(db, { session_id, limit = 20 } = {}) {
  const now = Date.now();
  if (session_id) {
    return db.prepare(`
      SELECT lease_id, session_id, normalized_action_hash, executable, cwd,
             parser_version, expires_at, max_uses, uses_count, classification_ceiling,
             issued_from_compass_log_id, revoked_at, created_at
      FROM safe_repeat_leases
      WHERE session_id = ? AND (revoked_at IS NULL) AND expires_at > ?
      ORDER BY created_at DESC LIMIT ?
    `).all(session_id, now, limit);
  }
  return db.prepare(`
    SELECT lease_id, session_id, normalized_action_hash, executable, cwd,
           parser_version, expires_at, max_uses, uses_count, classification_ceiling,
           issued_from_compass_log_id, revoked_at, created_at
    FROM safe_repeat_leases
    WHERE revoked_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC LIMIT ?
  `).all(now, limit);
}

/**
 * Can this lease cover a PAUSE decision? Never covers WITNESS.
 */
function leaseCovers(lease, decision) {
  if (!lease || !decision) return false;
  if (decision.classification === 'WITNESS') return false;
  if (decision.classification !== 'PAUSE') return false;
  const ceiling = lease.classification_ceiling || 'PAUSE';
  if (ceiling === 'OPEN') return true;
  if (ceiling === 'PAUSE' && decision.classification === 'PAUSE') return true;
  return false;
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_MAX_USES,
  armLease,
  findActiveLease,
  consumeLease,
  revokeLease,
  listLeases,
  leaseCovers,
  newLeaseId
};
