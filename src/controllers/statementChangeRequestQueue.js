const User = require('../models/User');
const ChangeRequest = require('../models/ChangeRequest');
const { effectiveSidebarPermissions } = require('../constants/sidebarPermissions');
const {
  resolveCardStatementRow,
  statementPayloadToUpdateData,
} = require('../services/cardStatementRequestApply');
const changeRequestEvents = require('../services/changeRequestEvents');

async function assertUserCanQueueStatement(req) {
  const dbUser = await User.findById(req.user.id);
  if (!dbUser) {
    const e = new Error('User not found');
    e.status = 401;
    throw e;
  }
  const perms = effectiveSidebarPermissions(dbUser.role, dbUser.sidebarPermissionsStored);
  if (!perms.credit_cards) {
    const e = new Error('Credit Cards access is required.');
    e.code = 'SIDEBAR_PERMISSION_REQUIRED';
    e.status = 403;
    throw e;
  }
}

/**
 * Standard user PATCH/PUT/POST /api/statements/:id — queue field edits (no direct DB write).
 */
async function queueStatementFieldChange(req, res) {
  try {
    await assertUserCanQueueStatement(req);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      success: false,
      code: e.code,
      error: e.message,
    });
  }

  if (req.file) {
    return res.status(400).json({
      success: false,
      code: 'MULTIPART_NOT_SUPPORTED_FOR_USER',
      error:
        'Standard users cannot upload a PDF on this call. Send JSON field changes only; your edit will go to admin for approval. PDFs are attached by an admin (or after approval).',
    });
  }

  const { id } = req.params;
  const { month } = req.query;
  const body = req.body || {};
  const payloadIn = { ...body };
  if (month) payloadIn.statementMonth = month;

  let row;
  try {
    row = await resolveCardStatementRow(id, payloadIn);
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }

  let updateKeys;
  try {
    updateKeys = statementPayloadToUpdateData(payloadIn);
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }

  if (Object.keys(updateKeys).length === 0) {
    return res.status(400).json({
      success: false,
      error:
        'No changes to submit. Include at least one field (e.g. total_due, paid_amount, epp_balance, balance_transfer, statement_date, due_date, due_month — same formats as admin PATCH).',
    });
  }

  const totalDue =
    updateKeys.total_due !== undefined ? updateKeys.total_due : parseFloat(row.total_due || 0);
  const paidAmt =
    updateKeys.paid_amount !== undefined ? updateKeys.paid_amount : parseFloat(row.paid_amount || 0);
  const eppBal =
    updateKeys.epp_balance !== undefined ? updateKeys.epp_balance : parseFloat(row.epp_balance || 0);
  if (paidAmt + eppBal > totalDue + 1e-9) {
    return res.status(400).json({
      success: false,
      error: 'Paid amount + EPP cannot exceed Total Payment Due for the requested values.',
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
      resourceType: 'card_statement',
      resourceId: id,
      payload: payloadIn,
      requestNote: note || null,
    });

    changeRequestEvents.emit('new_request', {
      requestId: created.id,
      action: 'edit',
      resourceType: 'card_statement',
      resourceId: id,
      requesterId: req.user.id,
      requesterUsername: req.user.username,
      note: note || null,
      status: 'pending',
    });

    return res.status(202).json({
      success: true,
      code: 'CHANGE_REQUEST_SUBMITTED',
      message: 'Your edit was sent for admin approval. It is not applied until approved.',
      request: created,
    });
  } catch (err) {
    console.error('queueStatementFieldChange:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * Standard user DELETE /api/statements/:id/attachment — queue PDF removal.
 */
async function queueStatementAttachmentRemoval(req, res) {
  try {
    await assertUserCanQueueStatement(req);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      success: false,
      code: e.code,
      error: e.message,
    });
  }

  const { id } = req.params;
  const { month } = req.query;
  const payloadIn = { removeAttachment: true };
  if (month) payloadIn.statementMonth = month;

  try {
    await resolveCardStatementRow(id, payloadIn);
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

  try {
    const created = await ChangeRequest.create({
      requesterId: req.user.id,
      action: 'edit',
      resourceType: 'card_statement',
      resourceId: id,
      payload: payloadIn,
      requestNote: note || null,
    });

    changeRequestEvents.emit('new_request', {
      requestId: created.id,
      action: 'edit',
      resourceType: 'card_statement',
      resourceId: id,
      requesterId: req.user.id,
      requesterUsername: req.user.username,
      note: note || null,
      status: 'pending',
    });

    return res.status(202).json({
      success: true,
      code: 'CHANGE_REQUEST_SUBMITTED',
      message: 'Remove PDF request sent for admin approval.',
      request: created,
    });
  } catch (err) {
    console.error('queueStatementAttachmentRemoval:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = {
  queueStatementFieldChange,
  queueStatementAttachmentRemoval,
};