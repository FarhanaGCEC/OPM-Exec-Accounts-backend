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
}

module.exports = ReceivablesCategory;







