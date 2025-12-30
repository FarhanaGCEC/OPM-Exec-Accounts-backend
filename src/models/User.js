const { pool } = require('../config/database');

class User {
  static async create(username, password) {
    try {
      // Check if user already exists
      const existingUser = await this.findByUsername(username);
      if (existingUser) {
        throw new Error('Username already exists');
      }

      // Insert new user
      const result = await pool.query(
        'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username, created_at',
        [username, password]
      );

      return {
        id: result.rows[0].id,
        username: result.rows[0].username,
        password: password, // Return hashed password
        createdAt: result.rows[0].created_at
      };
    } catch (error) {
      if (error.code === '23505') { // PostgreSQL unique violation
        throw new Error('Username already exists');
      }
      throw error;
    }
  }

  static async findByUsername(username) {
    try {
      const result = await pool.query(
        'SELECT id, username, password, created_at FROM users WHERE username = $1',
        [username]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const user = result.rows[0];
      return {
        id: user.id,
        username: user.username,
        password: user.password,
        createdAt: user.created_at
      };
    } catch (error) {
      throw error;
    }
  }

  static async findById(id) {
    try {
      const result = await pool.query(
        'SELECT id, username, password, created_at FROM users WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const user = result.rows[0];
      return {
        id: user.id,
        username: user.username,
        password: user.password,
        createdAt: user.created_at
      };
    } catch (error) {
      throw error;
    }
  }

  // For development/testing - get all users (remove in production)
  static async getAll() {
    try {
      const result = await pool.query(
        'SELECT id, username, created_at FROM users ORDER BY created_at DESC'
      );
      return result.rows;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = User;
