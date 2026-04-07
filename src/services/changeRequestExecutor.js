const Transaction = require('../models/Transaction');
const User = require('../models/User');
const PayablesCategory = require('../models/PayablesCategory');
const ReceivablesCategory = require('../models/ReceivablesCategory');

function parsePayload(reqRow) {
  const p = reqRow.payload;
  if (p == null) return {};
  if (typeof p === 'object') return p;
  try {
    return JSON.parse(p);
  } catch {
    return {};
  }
}

async function assertNotOnlyAdminUser(userId) {
  const u = await User.findById(userId);
  if (!u || u.role !== 'admin') return;
  const c = await User.countByRole('admin');
  if (c <= 1) {
    throw new Error('Cannot remove the only admin account');
  }
}

/**
 * Run the approved change. Throws on failure.
 */
async function executeApprovedRequest(reqRow) {
  const { action, resourceType, resourceId, requesterId } = reqRow;
  const payload = parsePayload(reqRow);

  if (resourceType === 'transaction') {
    const id = parseInt(resourceId, 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new Error('Invalid transaction id');
    }
    const txn = await Transaction.getById(id);
    if (!txn) throw new Error('Transaction not found');
    if (txn.created_by != null && Number(txn.created_by) !== Number(requesterId)) {
      throw new Error('Not your transaction');
    }
    if (action === 'delete') {
      const ok = await Transaction.delete(id);
      if (!ok) throw new Error('Failed to delete transaction');
      return;
    }
    if (action === 'edit') {
      const required = ['date', 'type', 'amount', 'paymentType'];
      for (const k of required) {
        if (payload[k] === undefined || payload[k] === null) {
          throw new Error(`Payload missing: ${k}`);
        }
      }
      const updated = await Transaction.update(id, {
        date: payload.date,
        type: payload.type,
        categoryId: payload.categoryId,
        paymentType: payload.paymentType,
        chequeNumber: payload.chequeNumber,
        amount: payload.amount,
        remarks: payload.remarks,
      });
      if (!updated) throw new Error('Failed to update transaction');
      return;
    }
  }

  if (resourceType === 'payables_category') {
    const id = parseInt(resourceId, 10);
    if (!Number.isInteger(id) || id < 1) throw new Error('Invalid category id');
    const row = await PayablesCategory.getById(id);
    if (!row) throw new Error('Payables category not found');
    if (action === 'delete') {
      const ok = await PayablesCategory.delete(id);
      if (!ok) throw new Error('Failed to delete payables category');
      return;
    }
    if (action === 'edit') {
      const name = payload.name != null ? String(payload.name).trim() : '';
      if (!name) throw new Error('payload.name is required');
      const updated = await PayablesCategory.update(id, name);
      if (!updated) throw new Error('Failed to update payables category');
      return;
    }
  }

  if (resourceType === 'receivables_category') {
    const id = parseInt(resourceId, 10);
    if (!Number.isInteger(id) || id < 1) throw new Error('Invalid category id');
    const row = await ReceivablesCategory.getById(id);
    if (!row) throw new Error('Receivables category not found');
    if (action === 'delete') {
      const ok = await ReceivablesCategory.delete(id);
      if (!ok) throw new Error('Failed to delete receivables category');
      return;
    }
    if (action === 'edit') {
      const name = payload.name != null ? String(payload.name).trim() : '';
      if (!name) throw new Error('payload.name is required');
      const updated = await ReceivablesCategory.update(id, name);
      if (!updated) throw new Error('Failed to update receivables category');
      return;
    }
  }

  if (resourceType === 'user_self') {
    const uid = parseInt(resourceId, 10);
    if (!Number.isInteger(uid) || uid < 1) throw new Error('Invalid user id');
    if (Number(uid) !== Number(requesterId)) {
      throw new Error('Invalid user self request');
    }
    if (action === 'delete') {
      await assertNotOnlyAdminUser(uid);
      await User.deleteById(uid);
      return;
    }
    if (action === 'edit') {
      const username = payload.username != null ? String(payload.username).trim() : '';
      if (username.length < 3) {
        throw new Error('Username must be at least 3 characters');
      }
      await User.updateUsername(uid, username);
      return;
    }
  }

  throw new Error(`Unsupported resource_type / action: ${resourceType} / ${action}`);
}

module.exports = { executeApprovedRequest };
