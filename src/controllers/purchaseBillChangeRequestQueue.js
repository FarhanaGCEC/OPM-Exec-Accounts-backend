const User = require('../models/User');
const PurchaseBill = require('../models/PurchaseBill');
const ChangeRequest = require('../models/ChangeRequest');
const { USER_ROLES } = require('../constants/roles');
const { effectiveSidebarPermissions } = require('../constants/sidebarPermissions');
const { payloadToPurchaseBillUpdate } = require('../utils/purchaseBillPayload');
const changeRequestEvents = require('../services/changeRequestEvents');

async function assertUserCanQueuePurchaseBill(req, row) {
  if (req.user.role !== USER_ROLES.USER) return;
  const dbUser = await User.findById(req.user.id);
  if (!dbUser) {
    const e = new Error('User not found');
    e.status = 401;
    throw e;
  }
  const perms = effectiveSidebarPermissions(dbUser.role, dbUser.sidebarPermissionsStored);
  if (!perms.credit_cards) {
    const e = new Error('Credit Cards access is required to request purchase bill changes.');
    e.code = 'SIDEBAR_PERMISSION_REQUIRED';
    e.status = 403;
    throw e;
  }
  if (row.created_by != null && Number(row.created_by) !== Number(req.user.id)) {
    const e = new Error('You can only request changes for purchase bills you created');
    e.status = 403;
    throw e;
  }
}

function emitPurchaseBillRequest(created, req, id, action, note) {
  changeRequestEvents.emit('new_request', {
    requestId: created.id,
    action,
    resourceType: 'purchase_bill',
    resourceId: String(id),
    requesterId: req.user.id,
    requesterUsername: req.user.username,
    note: note || null,
    status: 'pending',
  });
}

async function queuePurchaseBillDelete(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ success: false, error: 'Invalid purchase bill id' });
  }
  try {
    const row = await PurchaseBill.getById(id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Purchase bill not found' });
    }
    await assertUserCanQueuePurchaseBill(req, row);
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
      resourceType: 'purchase_bill',
      resourceId: String(id),
      payload: null,
      requestNote: note || null,
    });
    emitPurchaseBillRequest(created, req, id, 'delete', note);
    return res.status(202).json({
      success: true,
      code: 'CHANGE_REQUEST_SUBMITTED',
      message: 'Delete request sent for admin approval. The bill is not removed until approved.',
      request: created,
    });
  } catch (err) {
    console.error('queuePurchaseBillDelete:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * PUT-style: bill_date + amount required in body (same as elevated route).
 */
async function queuePurchaseBillPut(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ success: false, error: 'Invalid purchase bill id' });
  }
  try {
    const row = await PurchaseBill.getById(id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Purchase bill not found' });
    }
    await assertUserCanQueuePurchaseBill(req, row);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      success: false,
      code: e.code,
      error: e.message,
    });
  }

  const body = req.body || {};
  let updateKeys;
  try {
    updateKeys = payloadToPurchaseBillUpdate(body, { requireBillDateAndAmount: true });
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }
  if (Object.keys(updateKeys).length === 0) {
    return res.status(400).json({ success: false, error: 'No valid fields to submit' });
  }

  const note =
    body.note != null
      ? String(body.note).trim()
      : body.requestNote != null
        ? String(body.requestNote).trim()
        : null;

  const payloadIn = { ...body };

  try {
    const created = await ChangeRequest.create({
      requesterId: req.user.id,
      action: 'edit',
      resourceType: 'purchase_bill',
      resourceId: String(id),
      payload: payloadIn,
      requestNote: note || null,
    });
    emitPurchaseBillRequest(created, req, id, 'edit', note);
    return res.status(202).json({
      success: true,
      code: 'CHANGE_REQUEST_SUBMITTED',
      message: 'Update request sent for admin approval.',
      request: created,
    });
  } catch (err) {
    console.error('queuePurchaseBillPut:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * PATCH-style: at least one field.
 */
async function queuePurchaseBillPatch(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ success: false, error: 'Invalid purchase bill id' });
  }
  try {
    const row = await PurchaseBill.getById(id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Purchase bill not found' });
    }
    await assertUserCanQueuePurchaseBill(req, row);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      success: false,
      code: e.code,
      error: e.message,
    });
  }

  const body = req.body || {};
  let updateKeys;
  try {
    updateKeys = payloadToPurchaseBillUpdate(body, { requireBillDateAndAmount: false });
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }

  if (Object.keys(updateKeys).length === 0) {
    return res.status(400).json({
      success: false,
      error:
        'No changes to submit. Include at least one of: bill_date, amount, invoice_number, vendor_name, bill_number, paid_against, payment_method, description, payment_status',
    });
  }

  const note =
    body.note != null
      ? String(body.note).trim()
      : body.requestNote != null
        ? String(body.requestNote).trim()
        : null;

  const payloadIn = { ...body };

  try {
    const created = await ChangeRequest.create({
      requesterId: req.user.id,
      action: 'edit',
      resourceType: 'purchase_bill',
      resourceId: String(id),
      payload: payloadIn,
      requestNote: note || null,
    });
    emitPurchaseBillRequest(created, req, id, 'edit', note);
    return res.status(202).json({
      success: true,
      code: 'CHANGE_REQUEST_SUBMITTED',
      message: 'Update request sent for admin approval.',
      request: created,
    });
  } catch (err) {
    console.error('queuePurchaseBillPatch:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = {
  queuePurchaseBillDelete,
  queuePurchaseBillPut,
  queuePurchaseBillPatch,
};
