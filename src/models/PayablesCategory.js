const { pool } = require('../config/database');

class PayablesCategory {
  // Get all payables categories
  static async getAll() {
    try {
      const result = await pool.query(
        'SELECT id, name, created_at, updated_at FROM payables_categories ORDER BY created_at DESC'
      );
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get a single payables category by ID
  static async getById(id) {
    try {
      const result = await pool.query(
        'SELECT id, name, created_at, updated_at FROM payables_categories WHERE id = ?',
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

  // Create a new payables category
  static async create(name) {
    try {
      await pool.query('INSERT INTO payables_categories (name) VALUES (?)', [name]);
      const result = await pool.query(
        'SELECT id, name, created_at, updated_at FROM payables_categories WHERE id = LAST_INSERT_ID()'
      );
      return result.rows[0];
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new Error('Category name already exists');
      }
      throw error;
    }
  }

  // Update a payables category
  static async update(id, name) {
    try {
      const updateResult = await pool.query(
        'UPDATE payables_categories SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [name, id]
      );
      if (updateResult.affectedRows === 0) return null;
      const result = await pool.query(
        'SELECT id, name, created_at, updated_at FROM payables_categories WHERE id = ?',
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

  // Delete a payables category
  static async delete(id) {
    try {
      const result = await pool.query(
        'DELETE FROM payables_categories WHERE id = ?',
        [id]
      );
      return result.affectedRows > 0;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = PayablesCategory;







