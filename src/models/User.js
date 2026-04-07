const { pool } = require('../config/database');

class User {
  static async create(username, password, role = 'user') {
    try {
      const existingUser = await this.findByUsername(username);
      if (existingUser) {
        throw new Error('Username already exists');
      }

      await pool.query(
        'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
        [username, password, role]
      );
      const result = await pool.query(
        'SELECT id, username, role, created_at FROM users WHERE username = ?',
        [username]
      );

      return {
        id: result.rows[0].id,
        username: result.rows[0].username,
        role: result.rows[0].role,
        createdAt: result.rows[0].created_at,
      };
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new Error('Username already exists');
      }
      throw error;
    }
  }

  static async findByUsername(username) {
    try {
      const result = await pool.query(
        'SELECT id, username, password, role, created_at FROM users WHERE username = ?',
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
        role: user.role || 'user',
        createdAt: user.created_at,
      };
    } catch (error) {
      throw error;
    }
  }

  static async findById(id) {
    try {
      const result = await pool.query(
        'SELECT id, username, password, role, created_at FROM users WHERE id = ?',
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
        role: user.role || 'user',
        createdAt: user.created_at,
      };
    } catch (error) {
      throw error;
    }
  }

  // For development/testing - get all users (remove in production)
  static async getAll() {
    try {
      const result = await pool.query(
        'SELECT id, username, role, created_at FROM users ORDER BY created_at DESC'
      );
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async updatePassword(id, hashedPassword) {
    const result = await pool.query('UPDATE users SET password = ? WHERE id = ?', [
      hashedPassword,
      id,
    ]);
    if (!result.affectedRows) {
      throw new Error('User not found');
    }
  }

  static async updateRole(id, role) {
    const result = await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
    if (!result.affectedRows) {
      throw new Error('User not found');
    }
  }

  static async updateUsername(id, username) {
    const trimmed = String(username).trim();
    const existingUser = await this.findByUsername(trimmed);
    if (existingUser && existingUser.id !== id) {
      throw new Error('Username already exists');
    }
    const result = await pool.query('UPDATE users SET username = ? WHERE id = ?', [trimmed, id]);
    if (!result.affectedRows) {
      throw new Error('User not found');
    }
  }

  static async deleteById(id) {
    const result = await pool.query('DELETE FROM users WHERE id = ?', [id]);
    if (!result.affectedRows) {
      throw new Error('User not found');
    }
  }

  static async countByRole(role) {
    const result = await pool.query('SELECT COUNT(*) AS c FROM users WHERE role = ?', [role]);
    return parseInt(result.rows[0].c, 10);
  }
}

module.exports = User;
