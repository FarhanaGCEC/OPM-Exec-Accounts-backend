const User = require('../models/User');
const CreditCardPayment = require('../models/CreditCardPayment');
const ChangeRequest = require('../models/ChangeRequest');
const { USER_ROLES } = require('../constants/roles');
const { effectiveSidebarPermissions } = require('../constants/sidebarPermissions');
const { payloadToCreditCardPaymentUpdate } = require('../utils/creditCardPaymentPayload');
const changeRequestEvents = require('../services/changeRequestEvents');

async function assertStandardUserCanMutateCreditCardPayment(req, row) {
  if (req.user.role !== USER_ROLES.USER) return;
  const dbUser = await User.findById(req.user.id);
  if (!dbUser) {
    const e = new Error('User not found');
    e.status = 401;
    throw e;
  }
  const perms = effectiveSidebarPermissions(dbUser.role, dbUser.sidebarPermissionsStored);
  if (!perms.customer_credit_card_payments && !perms.credit_cards) {
    const e = new Error(
      'Customer Credit Card Payments or Credit Cards access is required to request payment changes.'
    );
    e.code = 'SIDEBAR_PERMISSION_REQUIRED';
    e.status = 403;
    throw e;
  }
  if (row.created_by != null && Number(row.created_by) !== Number(req.user.id)) {
    const e = new Error('You can only request changes for credit card payments you created');
    e.status = 403;
    throw e;
  }
}

function emitCreditCardPaymentRequest(created, req, id, action, note) {
  changeRequestEvents.emit('new_request', {
    requestId: created.id,
    action,
    resourceType: 'credit_card_payment',
    resourceId: String(id),
    requesterId: req.user.id,
    requesterUsername: req.user.username,
    note: note || null,
    status: 'pending',
  });
}

async function queueCreditCardPaymentDelete(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ success: false, error: 'Invalid credit card payment id' });
  }
  try {
    const row = await CreditCardPayment.getById(id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Credit card payment not found' });
    }
    await assertStandardUserCanMutateCreditCardPayment(req, row);
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
      resourceType: 'credit_card_payment',
      resourceId: String(id),
      payload: null,
      requestNote: note || null,
    });
    emitCreditCardPaymentRequest(created, req, id, 'delete', note);
    return res.status(202).json({
      success: true,
      code: 'CHANGE_REQUEST_SUBMITTED',
      message: 'Delete request sent for admin approval. The payment is not removed until approved.',
      request: created,
    });
  } catch (err) {
    console.error('queueCreditCardPaymentDelete:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

async function queueCreditCardPaymentPut(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ success: false, error: 'Invalid credit card payment id' });
  }
  try {
    const row = await CreditCardPayment.getById(id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Credit card payment not found' });
    }
    await assertStandardUserCanMutateCreditCardPayment(req, row);
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
    updateKeys = payloadToCreditCardPaymentUpdate(body, { requirePaymentDateAndAmount: false });
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }
  if (Object.keys(updateKeys).length === 0) {
    return res.status(400).json({
      success: false,
      error:
        'No valid fields to submit. Include at least one of: payment_date, amount, credit_card_id, card_holder, remarks, paid_against',
    });
  }

  const note =
    body.note != null
      ? String(body.note).trim()
      : body.requestNote != null
        ? String(body.requestNote).trim()
        : null;

  try {
    const created = await ChangeRequest.create({
      requesterId: req.user.id,
      action: 'edit',
      resourceType: 'credit_card_payment',
      resourceId: String(id),
      payload: { ...body },
      requestNote: note || null,
    });
    emitCreditCardPaymentRequest(created, req, id, 'edit', note);
    return res.status(202).json({
      success: true,
      code: 'CHANGE_REQUEST_SUBMITTED',
      message: 'Update request sent for admin approval.',
      request: created,
    });
  } catch (err) {
    console.error('queueCreditCardPaymentPut:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

async function queueCreditCardPaymentPatch(req, res) {
  return queueCreditCardPaymentPut(req, res);
}

module.exports = {
  assertStandardUserCanMutateCreditCardPayment,
  queueCreditCardPaymentDelete,
  queueCreditCardPaymentPut,
  queueCreditCardPaymentPatch,
};
