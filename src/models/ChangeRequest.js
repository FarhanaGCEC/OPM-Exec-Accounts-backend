const { pool } = require('../config/database');

function parsePayload(row) {
  if (row.payload == null) return null;
  if (typeof row.payload === 'object') return row.payload;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    requesterId: row.requester_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    payload: parsePayload(row),
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
    return this.findById(insertResult.insertId);
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

  static async listForRequester(requesterId) {
    const rid = Number(requesterId);
    if (!Number.isInteger(rid) || rid < 1) {
      return [];
    }
    const result = await pool.query(
      `SELECT cr.*, u.username AS requester_username
       FROM change_requests cr
       LEFT JOIN users u ON u.id = cr.requester_id
       WHERE cr.requester_id = ?
       ORDER BY cr.created_at DESC`,
      [rid]
    );
    return result.rows.map((r) => mapRow(r));
  }

  static async listAll({ status } = {}) {
    let sql = `
      SELECT cr.*, u.username AS requester_username
      FROM change_requests cr
      LEFT JOIN users u ON u.id = cr.requester_id
    `;
    const params = [];
    if (status) {
      sql += ' WHERE cr.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY cr.status = "pending" DESC, cr.created_at DESC';
    const result = await pool.query(sql, params);
    return result.rows.map((r) => mapRow(r));
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
