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
        'SELECT id, name, created_at, updated_at FROM payables_categories WHERE id = $1',
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
      const result = await pool.query(
        'INSERT INTO payables_categories (name) VALUES ($1) RETURNING id, name, created_at, updated_at',
        [name]
      );

      return result.rows[0];
    } catch (error) {
      if (error.code === '23505') { // PostgreSQL unique violation
        throw new Error('Category name already exists');
      }
      throw error;
    }
  }

  // Update a payables category
  static async update(id, name) {
    try {
      const result = await pool.query(
        'UPDATE payables_categories SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, name, created_at, updated_at',
        [name, id]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error) {
      if (error.code === '23505') { // PostgreSQL unique violation
        throw new Error('Category name already exists');
      }
      throw error;
    }
  }

  // Delete a payables category
  static async delete(id) {
    try {
      const result = await pool.query(
        'DELETE FROM payables_categories WHERE id = $1 RETURNING id',
        [id]
      );

      return result.rows.length > 0;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = PayablesCategory;

