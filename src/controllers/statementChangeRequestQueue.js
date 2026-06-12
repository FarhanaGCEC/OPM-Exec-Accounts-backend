const User = require('../models/User');
const ChangeRequest = require('../models/ChangeRequest');
const { effectiveSidebarPermissions } = require('../constants/sidebarPermissions');
const {
  validateCardStatementTarget,
  statementPayloadToUpdateData,
  payloadHasRemoveAttachment,
} = require('../services/cardStatementRequestApply');
const {
  payloadHasStatementAttachment,
  decodeStatementPdfBase64FromPayload,
  stageStatementAttachmentInPayload,
  normalizeCardStatementRequestPayload,
} = require('../utils/statementPdfAttachment');
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
        'Standard users cannot upload multipart PDF on this call. Send JSON with field changes and/or attachmentBase64 (PDF, max 20MB); your edit will go to admin for approval.',
    });
  }

  const { id } = req.params;
  const { month } = req.query;
  const body = req.body || {};
  const payloadIn = normalizeCardStatementRequestPayload({ ...body }, { envelope: body });
  if (month) payloadIn.statementMonth = month;

  let row;
  try {
    row = await validateCardStatementTarget(id, payloadIn);
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }

  let updateKeys;
  try {
    updateKeys = statementPayloadToUpdateData(payloadIn);
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }

  const hasAttach = payloadHasStatementAttachment(payloadIn);
  const removeAtt = payloadHasRemoveAttachment(payloadIn);
  if (removeAtt && hasAttach) {
    return res.status(400).json({
      success: false,
      error: 'Cannot attach and remove statement PDF in the same request',
    });
  }
  if (Object.keys(updateKeys).length === 0 && !hasAttach && !removeAtt) {
    return res.status(400).json({
      success: false,
      error:
        'No changes to submit. Include at least one field (e.g. total_due, paid_amount, epp_balance, balance_transfer, statement_date, due_date, due_month), attachmentBase64 (PDF), or removeAttachment: true.',
    });
  }
  if (hasAttach) {
    const decoded = decodeStatementPdfBase64FromPayload(payloadIn);
    if (decoded && decoded.error) {
      return res.status(400).json({ success: false, error: decoded.error });
    }
  }

  const note =
    body.note != null
      ? String(body.note).trim()
      : body.requestNote != null
        ? String(body.requestNote).trim()
        : null;

  let storedPayload = payloadIn;
  if (hasAttach) {
    try {
      storedPayload = await stageStatementAttachmentInPayload(payloadIn, {
        requesterId: req.user.id,
      });
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message || 'Failed to stage statement attachment' });
    }
  }

  try {
    const created = await ChangeRequest.create({
      requesterId: req.user.id,
      action: 'edit',
      resourceType: 'card_statement',
      resourceId: id,
      payload: storedPayload,
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
      code: created.mergedIntoPending ? 'CHANGE_REQUEST_MERGED' : 'CHANGE_REQUEST_SUBMITTED',
      message: created.mergedIntoPending
        ? 'Your edit was merged with your pending request for this statement. Admin will review one combined request.'
        : 'Your edit was sent for admin approval. It is not applied until approved.',
      request: created,
    });
  } catch (err) {
    console.error('queueStatementFieldChange:', err);
    if (err && err.code === 'CONFLICTING_STATEMENT_ATTACHMENT') {
      return res.status(400).json({ success: false, error: err.message, code: err.code });
    }
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
    await validateCardStatementTarget(id, payloadIn);
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