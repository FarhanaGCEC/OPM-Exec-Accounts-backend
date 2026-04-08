const User = require('../models/User');
const PDC = require('../models/PDC');
const ChangeRequest = require('../models/ChangeRequest');
const { USER_ROLES } = require('../constants/roles');
const { effectiveSidebarPermissions } = require('../constants/sidebarPermissions');
const { validateAndBuildPdcUpdate } = require('../utils/pdcChangeRequestPayload');
const changeRequestEvents = require('../services/changeRequestEvents');

function hasPdcImageInRequest(req) {
  if (req.file) return true;
  const b = req.body || {};
  const b64 =
    b.attachmentBase64 ?? b.attachment_base64 ?? b.chequeImageBase64 ?? b.cheque_image_base64;
  return b64 != null && String(b64).trim() !== '';
}

async function assertUserCanQueuePdc(req, row) {
  if (req.user.role !== USER_ROLES.USER) return;
  const dbUser = await User.findById(req.user.id);
  if (!dbUser) {
    const e = new Error('User not found');
    e.status = 401;
    throw e;
  }
  const perms = effectiveSidebarPermissions(dbUser.role, dbUser.sidebarPermissionsStored);
  if (!perms.post_dated_cheques) {
    const e = new Error('Post-Dated Cheques access is required to request PDC changes.');
    e.code = 'SIDEBAR_PERMISSION_REQUIRED';
    e.status = 403;
    throw e;
  }
  if (row.created_by != null && Number(row.created_by) !== Number(req.user.id)) {
    const e = new Error('You can only request changes for post-dated cheques you created');
    e.status = 403;
    throw e;
  }
}

function emitPdc(req, created, id, action, note) {
  changeRequestEvents.emit('new_request', {
    requestId: created.id,
    action,
    resourceType: 'post_dated_cheque',
    resourceId: String(id),
    requesterId: req.user.id,
    requesterUsername: req.user.username,
    note: note || null,
    status: 'pending',
  });
}

async function queuePdcDelete(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ success: false, error: 'Invalid PDC id' });
  }
  try {
    const row = await PDC.getById(id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Post-dated cheque not found' });
    }
    await assertUserCanQueuePdc(req, row);
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
      resourceType: 'post_dated_cheque',
      resourceId: String(id),
      payload: null,
      requestNote: note || null,
    });
    emitPdc(req, created, id, 'delete', note);
    return res.status(202).json({
      success: true,
      code: 'CHANGE_REQUEST_SUBMITTED',
      message: 'Delete request sent for admin approval.',
      request: created,
    });
  } catch (err) {
    console.error('queuePdcDelete:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

async function queuePdcUpdate(req, res) {
  if (hasPdcImageInRequest(req)) {
    return res.status(400).json({
      success: false,
      code: 'IMAGE_REQUIRES_ADMIN',
      error:
        'Standard users cannot upload a cheque image on this call. Send JSON fields only for approval, or ask an admin to update the image.',
    });
  }

  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ success: false, error: 'Invalid PDC id' });
  }
  try {
    const row = await PDC.getById(id);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Post-dated cheque not found' });
    }
    await assertUserCanQueuePdc(req, row);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      success: false,
      code: e.code,
      error: e.message,
    });
  }

  const built = validateAndBuildPdcUpdate(req.body || {});
  if (!built.ok) {
    return res.status(400).json({
      success: false,
      error: built.error,
      ...(built.missingFields && { missingFields: built.missingFields }),
    });
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
      resourceType: 'post_dated_cheque',
      resourceId: String(id),
      payload: payloadIn,
      requestNote: note || null,
    });
    emitPdc(req, created, id, 'edit', note);
    return res.status(202).json({
      success: true,
      code: 'CHANGE_REQUEST_SUBMITTED',
      message: 'PDC update request sent for admin approval.',
      request: created,
    });
  } catch (err) {
    console.error('queuePdcUpdate:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = {
  queuePdcDelete,
  queuePdcUpdate,
};
