const Transaction = require('../models/Transaction');
const User = require('../models/User');
const PayablesCategory = require('../models/PayablesCategory');
const ReceivablesCategory = require('../models/ReceivablesCategory');
const { applyApprovedCardStatementRequest } = require('./cardStatementRequestApply');
const PurchaseBill = require('../models/PurchaseBill');
const { payloadToPurchaseBillUpdate } = require('../utils/purchaseBillPayload');
const {
  normalizeTransactionEditPayload,
  assertTransactionEditRequired,
} = require('../utils/transactionChangePayload');
const { validateAndBuildPdcUpdate } = require('../utils/pdcChangeRequestPayload');
const PDC = require('../models/PDC');
const { destroyPdcChequeImage } = require('../services/cloudinaryPdcUpload');

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
      const norm = normalizeTransactionEditPayload(payload);
      assertTransactionEditRequired(norm);
      const updated = await Transaction.update(id, {
        date: norm.date,
        type: norm.type,
        categoryId: norm.categoryId,
        paymentType: norm.paymentType,
        chequeNumber: norm.chequeNumber,
        amount: norm.amount,
        remarks: norm.remarks,
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

  if (resourceType === 'card_statement') {
    await applyApprovedCardStatementRequest({
      action,
      resourceId,
      payload,
    });
    return;
  }

  if (resourceType === 'post_dated_cheque') {
    const id = parseInt(resourceId, 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new Error('Invalid post-dated cheque id');
    }
    const row = await PDC.getById(id);
    if (!row) throw new Error('Post-dated cheque not found');
    if (action === 'delete') {
      if (row.attachment_cloudinary_public_id) {
        try {
          await destroyPdcChequeImage(
            row.attachment_cloudinary_public_id,
            row.attachment_resource_type || 'image'
          );
        } catch (e) {
          console.error('destroyPdcChequeImage on approved delete:', e.message);
        }
      }
      const ok = await PDC.delete(id);
      if (!ok) throw new Error('Failed to delete post-dated cheque');
      return;
    }
    if (action === 'edit') {
      const built = validateAndBuildPdcUpdate(payload);
      if (!built.ok) {
        throw new Error(built.error || 'Invalid PDC payload');
      }
      const updated = await PDC.update(id, built.value);
      if (!updated) throw new Error('Failed to update post-dated cheque');
      return;
    }
  }

  if (resourceType === 'purchase_bill') {
    const id = parseInt(resourceId, 10);
    if (!Number.isInteger(id) || id < 1) {
      throw new Error('Invalid purchase bill id');
    }
    const row = await PurchaseBill.getById(id);
    if (!row) throw new Error('Purchase bill not found');
    if (action === 'delete') {
      const ok = await PurchaseBill.delete(id);
      if (!ok) throw new Error('Failed to delete purchase bill');
      return;
    }
    if (action === 'edit') {
      const u = payloadToPurchaseBillUpdate(payload, { requireBillDateAndAmount: false });
      if (Object.keys(u).length === 0) {
        throw new Error('Empty purchase bill update payload');
      }
      const updated = await PurchaseBill.update(id, u);
      if (!updated) throw new Error('Failed to update purchase bill');
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
