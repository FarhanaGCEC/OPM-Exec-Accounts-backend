const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { pool } = require('../config/database');
const { isValidUserRole, USER_ROLES } = require('../constants/roles');
const {
  SIDEBAR_MENU_ITEMS,
  effectiveSidebarPermissions,
  normalizePermissionsInput,
} = require('../constants/sidebarPermissions');

async function createUser(req, res) {
  const username = req.body.username || req.body.Username;
  const password = req.body.password || req.body.Password;
  const roleRaw =
    req.body.role != null ? String(req.body.role).trim().toLowerCase() : USER_ROLES.USER;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters long' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }
  if (!isValidUserRole(roleRaw)) {
    return res.status(400).json({
      error: 'Invalid role',
      allowed: ['admin', 'accountant', 'user'],
    });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create(username, hashedPassword, roleRaw);

    const permBody =
      req.body.permissions !== undefined
        ? req.body.permissions
        : req.body.sidebarPermissions !== undefined
          ? req.body.sidebarPermissions
          : undefined;
    if (roleRaw === USER_ROLES.USER && permBody !== undefined) {
      const normalized = normalizePermissionsInput(permBody);
      await User.updateSidebarPermissions(user.id, normalized);
    }

    const userWithPerms = await User.findById(user.id);
    return res.status(201).json({
      message: 'User created successfully',
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.createdAt,
        sidebarPermissions: effectiveSidebarPermissions(
          userWithPerms.role,
          userWithPerms.sidebarPermissionsStored
        ),
      },
    });
  } catch (error) {
    if (error.message === 'Username already exists') {
      return res.status(409).json({ error: error.message });
    }
    console.error('createUser:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function rejectUsernameMutation(body, res) {
  if (
    body == null ||
    (body.username === undefined &&
      body.Username === undefined &&
      body.userName === undefined)
  ) {
    return false;
  }
  res.status(400).json({
    error: 'Username cannot be changed after the account is created',
    hint: 'Only password and role can be updated for an existing user.',
  });
  return true;
}

async function updatePassword(req, res) {
  const id = parseInt(req.params.id, 10);
  const password = req.body.password || req.body.Password;

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  if (rejectUsernameMutation(req.body, res)) return;
  if (!password || password.length < 6) {
    return res.status(400).json({
      error: 'Password is required and must be at least 6 characters long',
    });
  }

  try {
    const existing = await User.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.updatePassword(id, hashedPassword);
    return res.json({ message: 'Password updated successfully', userId: id });
  } catch (error) {
    console.error('updatePassword:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function updateUserRole(req, res) {
  const id = parseInt(req.params.id, 10);
  const roleRaw =
    req.body.role != null ? String(req.body.role).trim().toLowerCase() : '';

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  if (rejectUsernameMutation(req.body, res)) return;
  if (!isValidUserRole(roleRaw)) {
    return res.status(400).json({
      error: 'Invalid role',
      allowed: ['admin', 'accountant', 'user'],
    });
  }

  try {
    const existing = await User.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }
    await User.updateRole(id, roleRaw);
    const updated = await User.findById(id);
    return res.json({
      message: 'Role updated successfully',
      user: {
        id: updated.id,
        username: updated.username,
        role: updated.role,
        createdAt: updated.createdAt,
        sidebarPermissions: effectiveSidebarPermissions(
          updated.role,
          updated.sidebarPermissionsStored
        ),
      },
    });
  } catch (error) {
    console.error('updateUserRole:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function deleteUser(req, res) {
  const id = parseInt(req.params.id, 10);
  const adminId = req.user.id;

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  if (id === adminId) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  try {
    const target = await User.findById(id);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (target.role === USER_ROLES.ADMIN) {
      const adminCount = await User.countByRole(USER_ROLES.ADMIN);
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the only admin user' });
      }
    }
    await User.deleteById(id);
    return res.json({ message: 'User deleted successfully', deletedId: id });
  } catch (error) {
    if (error.message === 'User not found') {
      return res.status(404).json({ error: error.message });
    }
    console.error('deleteUser:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function listUsers(req, res) {
  try {
    const rows = await User.getAll();
    return res.json({
      success: true,
      users: rows.map((u) => {
        const role = u.role ?? u.user_role ?? 'user';
        return {
          id: u.id,
          username: u.username,
          role,
          createdAt: u.created_at ?? u.createdAt ?? null,
          sidebarPermissions: effectiveSidebarPermissions(role, u.sidebar_permissions),
          sidebarPermissionsStored:
            role === USER_ROLES.USER ? normalizePermissionsInput(u.sidebarPermissionsStored) : null,
        };
      }),
    });
  } catch (error) {
    console.error('listUsers:', error.message || error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: process.env.NODE_ENV !== 'production' ? String(error.message || error) : undefined,
    });
  }
}

/**
 * Wipe payables (creditor) and/or receivables (debtor) category master data.
 * Unlinks matching category_id on transactions so rows stay valid.
 * Admin only; body: { scope: "payables" | "receivables" | "both", confirm: true }
 */
async function clearLedgerCategories(req, res) {
  const scope = req.body && req.body.scope != null ? String(req.body.scope).trim().toLowerCase() : '';
  const confirm = req.body && req.body.confirm === true;

  if (!confirm) {
    return res.status(400).json({
      error:
        'Dangerous operation. Send JSON { "scope": "payables" | "receivables" | "both", "confirm": true }. Creditors = payables; debtors = receivables.',
    });
  }

  if (!['payables', 'receivables', 'both'].includes(scope)) {
    return res.status(400).json({
      error: 'scope must be payables, receivables, or both',
    });
  }

  const conn = await pool.connect();
  await conn.beginTransaction();
  try {
    let payablesDeleted = 0;
    let receivablesDeleted = 0;
    let txPayableUnlinked = 0;
    let txReceivableUnlinked = 0;

    if (scope === 'payables' || scope === 'both') {
      const u = await conn.query(
        `UPDATE transactions SET category_id = NULL, category_type = NULL WHERE category_type = 'payable'`
      );
      txPayableUnlinked = u.affectedRows ?? 0;
      const d = await conn.query('DELETE FROM payables_categories');
      payablesDeleted = d.affectedRows ?? 0;
    }
    if (scope === 'receivables' || scope === 'both') {
      const u = await conn.query(
        `UPDATE transactions SET category_id = NULL, category_type = NULL WHERE category_type = 'receivable'`
      );
      txReceivableUnlinked = u.affectedRows ?? 0;
      const d = await conn.query('DELETE FROM receivables_categories');
      receivablesDeleted = d.affectedRows ?? 0;
    }

    await conn.commit();
    return res.json({
      success: true,
      message: 'Ledger category tables cleared for the requested scope.',
      scope,
      payablesCategoriesRemoved: payablesDeleted,
      receivablesCategoriesRemoved: receivablesDeleted,
      dailyTransactionsUnlinkedFromPayable: txPayableUnlinked,
      dailyTransactionsUnlinkedFromReceivable: txReceivableUnlinked,
    });
  } catch (error) {
    await conn.rollback();
    console.error('clearLedgerCategories:', error);
    return res.status(500).json({ error: 'Failed to clear ledger categories' });
  } finally {
    conn.release();
  }
}

async function getUserSidebarPermissions(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  try {
    const existing = await User.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }
    const role = existing.role || USER_ROLES.USER;
    return res.json({
      success: true,
      userId: id,
      role,
      menuItems: SIDEBAR_MENU_ITEMS,
      sidebarPermissions: effectiveSidebarPermissions(role, existing.sidebarPermissionsStored),
      sidebarPermissionsStored:
        role === USER_ROLES.USER
          ? normalizePermissionsInput(existing.sidebarPermissionsStored)
          : null,
      hint:
        role !== USER_ROLES.USER
          ? 'Only the standard user role uses stored permissions; admin and accountant always have full menu access.'
          : undefined,
    });
  } catch (error) {
    console.error('getUserSidebarPermissions:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function updateUserSidebarPermissions(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const raw =
    body.permissions !== undefined
      ? body.permissions
      : body.sidebarPermissions !== undefined
        ? body.sidebarPermissions
        : body;

  try {
    const existing = await User.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }
    const role = existing.role || USER_ROLES.USER;
    if (role !== USER_ROLES.USER) {
      return res.status(400).json({
        error:
          'Sidebar permissions can only be assigned to standard users (role "user"). Admin and accountant accounts always have full access.',
      });
    }
    const normalized = normalizePermissionsInput(raw);
    await User.updateSidebarPermissions(id, normalized);
    return res.json({
      success: true,
      message: 'Sidebar permissions updated',
      userId: id,
      sidebarPermissions: effectiveSidebarPermissions(USER_ROLES.USER, normalized),
      sidebarPermissionsStored: normalized,
    });
  } catch (error) {
    if (error.message === 'User not found') {
      return res.status(404).json({ error: error.message });
    }
    console.error('updateUserSidebarPermissions:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  createUser,
  updatePassword,
  updateUserRole,
  deleteUser,
  listUsers,
  clearLedgerCategories,
  getUserSidebarPermissions,
  updateUserSidebarPermissions,
};
