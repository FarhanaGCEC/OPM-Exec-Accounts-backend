const { pool } = require('../config/database');
const { randomUUID } = require('crypto');

class CardStatementEpp {
  static async listByStatementId(statementId) {
    if (!statementId) return [];
    const result = await pool.query(
      `SELECT id, statement_id, amount, paid_at, note, sort_order, created_at
       FROM card_statement_epp_payments
       WHERE statement_id = ?
       ORDER BY sort_order ASC, created_at ASC`,
      [statementId]
    );
    return result.rows;
  }

  static async listByStatementIds(statementIds) {
    const ids = (statementIds || []).filter(Boolean);
    if (!ids.length) return {};

    const placeholders = ids.map(() => '?').join(',');
    const result = await pool.query(
      `SELECT id, statement_id, amount, paid_at, note, sort_order, created_at
       FROM card_statement_epp_payments
       WHERE statement_id IN (${placeholders})
       ORDER BY sort_order ASC, created_at ASC`,
      ids
    );

    const byStatementId = {};
    for (const id of ids) byStatementId[id] = [];
    for (const row of result.rows) {
      if (!byStatementId[row.statement_id]) byStatementId[row.statement_id] = [];
      byStatementId[row.statement_id].push(row);
    }
    return byStatementId;
  }

  /**
   * Replace all partial EPP rows for a statement.
   * @param {string} statementId
   * @param {Array<{ amount: number, paid_at?: string|null, note?: string|null }>} entries
   * @param {{ query?: Function }|null} client - optional transactional client
   */
  static async replaceForStatement(statementId, entries, client = null) {
    const exec = client && client.query ? client.query.bind(client) : pool.query.bind(pool);
    const list = Array.isArray(entries) ? entries : [];

    await exec('DELETE FROM card_statement_epp_payments WHERE statement_id = ?', [statementId]);

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const amount = parseFloat(p.amount);
      if (Number.isNaN(amount) || amount < 0) {
        throw new Error('Each epp_payments amount must be a valid number >= 0');
      }
      await exec(
        `INSERT INTO card_statement_epp_payments
         (id, statement_id, amount, paid_at, note, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          statementId,
          amount,
          p.paid_at || null,
          p.note != null && String(p.note).trim() !== '' ? String(p.note).trim().slice(0, 255) : null,
          typeof p.sort_order === 'number' ? p.sort_order : i,
        ]
      );
    }

    return CardStatementEpp.listByStatementId(statementId);
  }
}

module.exports = CardStatementEpp;
