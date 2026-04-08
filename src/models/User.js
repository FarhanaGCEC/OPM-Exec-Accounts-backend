const { pool } = require('../config/database');
const { parseStoredPermissions, normalizePermissionsInput } = require('../constants/sidebarPermissions');

function mapUserRow(user) {
  if (!user) return null;
  const raw = user.sidebar_permissions;
  return {
    id: user.id,
    username: user.username,
    password: user.password,
    role: user.role || 'user',
    createdAt: user.created_at,
    sidebarPermissionsStored: parseStoredPermissions(raw),
  };
}

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
        'SELECT id, username, role, created_at, sidebar_permissions FROM users WHERE username = ?',
        [username]
      );

      const row = result.rows[0];
      return {
        id: row.id,
        username: row.username,
        role: row.role,
        createdAt: row.created_at,
        sidebarPermissionsStored: parseStoredPermissions(row.sidebar_permissions),
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
        'SELECT id, username, password, role, created_at, sidebar_permissions FROM users WHERE username = ?',
        [username]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return mapUserRow(result.rows[0]);
    } catch (error) {
      throw error;
    }
  }

  static async findById(id) {
    try {
      const result = await pool.query(
        'SELECT id, username, password, role, created_at, sidebar_permissions FROM users WHERE id = ?',
        [id]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return mapUserRow(result.rows[0]);
    } catch (error) {
      throw error;
    }
  }

  // For development/testing - get all users (remove in production)
  static async getAll() {
    try {
      const result = await pool.query(
        'SELECT id, username, role, created_at, sidebar_permissions FROM users ORDER BY created_at DESC'
      );
      return result.rows.map((row) => {
        const u = mapUserRow({ ...row, password: undefined });
        delete u.password;
        return {
          id: u.id,
          username: u.username,
          role: u.role,
          created_at: row.created_at,
          createdAt: row.created_at,
          sidebar_permissions: row.sidebar_permissions,
          sidebarPermissionsStored: u.sidebarPermissionsStored,
        };
      });
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

  static async updateSidebarPermissions(id, permissionsObject) {
    const normalized = normalizePermissionsInput(permissionsObject);
    const result = await pool.query(
      'UPDATE users SET sidebar_permissions = ? WHERE id = ?',
      [JSON.stringify(normalized), id]
    );
    if (!result.affectedRows) {
      throw new Error('User not found');
    }
  }
}

module.exports = User;
