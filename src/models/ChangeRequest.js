const { pool } = require('../config/database');
const {
  buildChangeRequestAttachmentPreview,
} = require('../utils/statementPdfAttachment');

const LIST_DEFAULT_LIMIT = 200;
const LIST_MAX_LIMIT = 500;

function clampListLimit(limit) {
  const n = parseInt(limit, 10);
  if (!Number.isFinite(n) || n < 1) return LIST_DEFAULT_LIMIT;
  return Math.min(n, LIST_MAX_LIMIT);
}

function clampListOffset(offset) {
  const n = parseInt(offset, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function parsePayload(row) {
  if (row.payload == null) return null;
  if (typeof row.payload === 'object') return row.payload;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

function normalizeResourceType(resourceType) {
  if (resourceType === 'pdc') return 'post_dated_cheque';
  return resourceType;
}

function normalizeResourceId(resourceId) {
  return String(resourceId);
}

function mapRow(row) {
  if (!row) return null;
  const resourceType = row.resource_type;
  const payload = parsePayload(row);
  return {
    id: row.id,
    requesterId: row.requester_id,
    action: row.action,
    resourceType,
    resourceId: row.resource_id,
    payload,
    attachmentPreview: buildChangeRequestAttachmentPreview(resourceType, payload),
    requestNote: row.request_note,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    createdAt: row.created_at,
    requesterUsername: row.requester_username,
  };
}

class ChangeRequest {
  static listLimitParam(limit) {
    return clampListLimit(limit);
  }

  static listOffsetParam(offset) {
    return clampListOffset(offset);
  }

  static async create({
    requesterId,
    action,
    resourceType,
    resourceId,
    payload,
    requestNote,
  }) {
    const rid = Number(requesterId);
    if (!Number.isInteger(rid) || rid < 1) {
      throw new Error('Invalid requester id');
    }
    const payloadJson = payload == null ? null : JSON.stringify(payload);
    const insertResult = await pool.query(
      `INSERT INTO change_requests
       (requester_id, action, resource_type, resource_id, payload, request_note, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [rid, action, resourceType, resourceId, payloadJson, requestNote || null]
    );
    if (!insertResult.insertId) {
      throw new Error('Failed to create change request');
    }
    const newId = insertResult.insertId;
    await this.rejectOtherPending({
      resourceType,
      resourceId,
      exceptId: newId,
      reviewedBy: null,
      reviewNote: `Superseded by newer request #${newId}`,
    });
    return this.findById(newId);
  }

  /**
   * Reject all other pending requests for the same resource (duplicate edit/delete queue).
   * Returns ids that were closed.
   */
  static async rejectOtherPending({
    resourceType,
    resourceId,
    exceptId,
    reviewedBy,
    reviewNote,
  }) {
    const rt = normalizeResourceType(resourceType);
    const rid = normalizeResourceId(resourceId);
    const except = Number(exceptId);

    const pending = await pool.query(
      `SELECT id FROM change_requests
       WHERE resource_type = ? AND resource_id = ? AND status = 'pending' AND id != ?`,
      [rt, rid, except]
    );
    if (!pending.rows.length) {
      return [];
    }

    await pool.query(
      `UPDATE change_requests
       SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_note = ?
       WHERE resource_type = ? AND resource_id = ? AND status = 'pending' AND id != ?`,
      [reviewedBy ?? null, reviewNote || null, rt, rid, except]
    );

    return pending.rows.map((r) => r.id);
  }

  static async findById(id) {
    const result = await pool.query(
      `SELECT cr.*, u.username AS requester_username
       FROM change_requests cr
       LEFT JOIN users u ON u.id = cr.requester_id
       WHERE cr.id = ?`,
      [id]
    );
    return mapRow(result.rows[0] || null);
  }

  static async listForRequester(requesterId, { limit, offset } = {}) {
    const rid = Number(requesterId);
    if (!Number.isInteger(rid) || rid < 1) {
      return [];
    }
    const lim = clampListLimit(limit);
    const off = clampListOffset(offset);
    const idResult = await pool.query(
      `SELECT id FROM change_requests
       WHERE requester_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [rid, lim, off]
    );
    return this._fetchRowsByIds(idResult.rows.map((r) => r.id));
  }

  /**
   * List change requests without sorting fat JSON columns in MySQL's sort buffer.
   * Phase 1: sort/limit narrow id rows; phase 2: fetch full rows by id.
   */
  static async listAll({ status, limit, offset } = {}) {
    const lim = clampListLimit(limit);
    const off = clampListOffset(offset);
    let idSql;
    const params = [];
    if (status) {
      idSql = `
        SELECT id FROM change_requests
        WHERE status = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`;
      params.push(status, lim, off);
    } else {
      idSql = `
        SELECT id FROM change_requests
        ORDER BY status = 'pending' DESC, created_at DESC
        LIMIT ? OFFSET ?`;
      params.push(lim, off);
    }
    const idResult = await pool.query(idSql, params);
    return this._fetchRowsByIds(idResult.rows.map((r) => r.id));
  }

  static async _fetchRowsByIds(ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const result = await pool.query(
      `SELECT cr.*, u.username AS requester_username
       FROM change_requests cr
       LEFT JOIN users u ON u.id = cr.requester_id
       WHERE cr.id IN (${placeholders})`,
      ids
    );
    const byId = new Map(result.rows.map((r) => [r.id, r]));
    return ids.map((id) => mapRow(byId.get(id))).filter(Boolean);
  }

  static async countPending() {
    const result = await pool.query(
      `SELECT COUNT(*) AS c FROM change_requests WHERE status = 'pending'`
    );
    return parseInt(result.rows[0].c, 10);
  }

  static async setReviewed(id, { status, reviewedBy, reviewNote }) {
    const result = await pool.query(
      `UPDATE change_requests
       SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_note = ?
       WHERE id = ? AND status = 'pending'`,
      [status, reviewedBy, reviewNote || null, id]
    );
    if (!result.affectedRows) {
      return null;
    }
    return this.findById(id);
  }
}

module.exports = ChangeRequest;
