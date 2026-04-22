const { pool } = require('../config/database');

class ReceivablesCategory {
  // Get all receivables categories
  static async getAll() {
    try {
      const result = await pool.query(
        'SELECT id, name, created_at, updated_at FROM receivables_categories ORDER BY created_at DESC'
      );
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get a single receivables category by ID
  static async getById(id) {
    try {
      const result = await pool.query(
        'SELECT id, name, created_at, updated_at FROM receivables_categories WHERE id = ?',
        [id]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  /**
   * Bulk insert category names. Trims, removes empties, dedupes case-insensitively by first occurrence order.
   * Uses INSERT IGNORE so existing DB names are skipped (not an error).
   * @param {string[]} names
   * @returns {Promise<{ created: object[], skippedDuplicates: string[] }>}
   */
  static async createMany(names) {
    const trimmed = names
      .map((n) => String(n ?? '').trim())
      .filter((n) => n.length > 0);
    const seen = new Set();
    const uniqueInOrder = [];
    for (const n of trimmed) {
      const key = n.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueInOrder.push(n);
    }

    if (uniqueInOrder.length === 0) {
      return { created: [], skippedDuplicates: [] };
    }

    const conn = await pool.connect();
    await conn.beginTransaction();
    const created = [];
    const skippedDuplicates = [];
    try {
      for (const name of uniqueInOrder) {
        const ins = await conn.query(
          'INSERT IGNORE INTO receivables_categories (name) VALUES (?)',
          [name]
        );
        if (ins.affectedRows > 0) {
          const row = await conn.query(
            'SELECT id, name, created_at, updated_at FROM receivables_categories WHERE id = LAST_INSERT_ID()'
          );
          created.push(row.rows[0]);
        } else {
          skippedDuplicates.push(name);
        }
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    return { created, skippedDuplicates };
  }

  // Create a new receivables category
  static async create(name) {
    try {
      await pool.query('INSERT INTO receivables_categories (name) VALUES (?)', [name]);
      const result = await pool.query(
        'SELECT id, name, created_at, updated_at FROM receivables_categories WHERE id = LAST_INSERT_ID()'
      );
      return result.rows[0];
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new Error('Category name already exists');
      }
      throw error;
    }
  }

  // Update a receivables category
  static async update(id, name) {
    try {
      const updateResult = await pool.query(
        'UPDATE receivables_categories SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [name, id]
      );
      if (updateResult.affectedRows === 0) return null;
      const result = await pool.query(
        'SELECT id, name, created_at, updated_at FROM receivables_categories WHERE id = ?',
        [id]
      );
      return result.rows[0] || null;
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new Error('Category name already exists');
      }
      throw error;
    }
  }

  // Delete a receivables category
  static async delete(id) {
    try {
      const result = await pool.query(
        'DELETE FROM receivables_categories WHERE id = ?',
        [id]
      );
      return result.affectedRows > 0;
    } catch (error) {
      throw error;
    }
  }

  // Count daily transactions linked to this receivable category
  static async countLinkedTransactions(id) {
    try {
      const result = await pool.query(
        "SELECT COUNT(*) AS cnt FROM transactions WHERE category_type = 'receivable' AND category_id = ?",
        [id]
      );
      const raw = result.rows && result.rows[0] ? result.rows[0].cnt : 0;
      return Number(raw) || 0;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = ReceivablesCategory;







