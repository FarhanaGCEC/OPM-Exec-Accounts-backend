const User = require('../models/User');
const Transaction = require('../models/Transaction');
const ChangeRequest = require('../models/ChangeRequest');
const { USER_ROLES } = require('../constants/roles');
const { effectiveSidebarPermissions } = require('../constants/sidebarPermissions');
const {
  normalizeTransactionEditPayload,
  assertTransactionEditRequired,
} = require('../utils/transactionChangePayload');
const changeRequestEvents = require('../services/changeRequestEvents');

async function assertUserCanQueueTransaction(req, row) {
  if (req.user.role !== USER_ROLES.USER) return;
  const dbUser = await User.findById(req.user.id);
  if (!dbUser) {
    const e = new Error('User not found');
    e.status = 401;
    throw e;
  }
  const perms = effectiveSidebarPermissions(dbUser.role, dbUser.sidebarPermissionsStored);
  if (!perms.daily_transactions) {
    const e = new Error('Daily Transactions access is required to request edits.');
    e.code = 'SIDEBAR_PERMISSION_REQUIRED';
    e.status = 403;
    throw e;
  }
  if (row.created_by != null && Number(row.created_by) !== Number(req.user.id)) {
    const e = new Error('You can only request changes for your own transactions');
    e.status = 403;
    throw e;
  }
}

function emitTxn(req, created, id, action, note) {
  changeRequestEvents.emit('new_request', {
    requestId: created.id,
    action,
    resourceType: 'transaction',
    resourceId: String(id),
    requesterId: req.user.id,
    requesterUsername: req.user.username,
    note: note || null,
    status: 'pending',
  });
}

async function queueTransactionDelete(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ success: false, error: 'Invalid transaction id' });
  }
  try {
    const row = await Transaction.getById(id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }
    await assertUserCanQueueTransaction(req, row);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      success: false,
      code: e.code,
      error: e.message,
    });
  }

  const body = req.body || {};
  const note =
    body.note != null
      ? String(body.note).trim()
      : body.requestNote != null
        ? String(body.requestNote).trim()
        : null;

  try {
    const created = await ChangeRequest.create({
      requesterId: req.user.id,
      action: 'delete',
      resourceType: 'transaction',
      resourceId: String(id),
      payload: null,
      requestNote: note || null,
    });
    emitTxn(req, created, id, 'delete', note);
    return res.status(202).json({
      success: true,
      code: 'CHANGE_REQUEST_SUBMITTED',
      message: 'Delete request sent for admin approval.',
      request: created,
    });
  } catch (err) {
    console.error('queueTransactionDelete:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

async function queueTransactionPut(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ success: false, error: 'Invalid transaction id' });
  }
  try {
    const row = await Transaction.getById(id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }
    await assertUserCanQueueTransaction(req, row);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      success: false,
      code: e.code,
      error: e.message,
    });
  }

  let norm;
  try {
    norm = normalizeTransactionEditPayload(req.body || {});
    assertTransactionEditRequired(norm);
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }

  const body = req.body || {};
  const note =
    body.note != null
      ? String(body.note).trim()
      : body.requestNote != null
        ? String(body.requestNote).trim()
        : null;

  const payloadIn = { ...req.body };

  try {
    const created = await ChangeRequest.create({
      requesterId: req.user.id,
      action: 'edit',
      resourceType: 'transaction',
      resourceId: String(id),
      payload: payloadIn,
      requestNote: note || null,
    });
    emitTxn(req, created, id, 'edit', note);
    return res.status(202).json({
      success: true,
      code: 'CHANGE_REQUEST_SUBMITTED',
      message: 'Update request sent for admin approval.',
      request: created,
    });
  } catch (err) {
    console.error('queueTransactionPut:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = {
  queueTransactionDelete,
  queueTransactionPut,
};
