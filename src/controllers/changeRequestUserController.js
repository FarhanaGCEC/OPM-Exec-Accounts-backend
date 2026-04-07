const Transaction = require('../models/Transaction');
const ChangeRequest = require('../models/ChangeRequest');
const PayablesCategory = require('../models/PayablesCategory');
const ReceivablesCategory = require('../models/ReceivablesCategory');
const changeRequestEvents = require('../services/changeRequestEvents');

const ALLOWED_TYPES = new Set([
  'transaction',
  'user_self',
  'payables_category',
  'receivables_category',
]);

async function submitChangeRequest(req, res) {
  const action = String(req.body.action || '').toLowerCase();
  const resourceType = String(
    req.body.resourceType || req.body.resource_type || ''
  ).toLowerCase();
  const resourceId =
    req.body.resourceId != null || req.body.resource_id != null
      ? String(req.body.resourceId ?? req.body.resource_id).trim()
      : '';
  const payload = req.body.payload;
  const note = req.body.note || req.body.requestNote;

  if (!['edit', 'delete'].includes(action)) {
    return res.status(400).json({ error: 'action must be edit or delete' });
  }
  if (!ALLOWED_TYPES.has(resourceType)) {
    return res.status(400).json({
      error: 'Invalid resourceType',
      allowed: [...ALLOWED_TYPES],
    });
  }
  if (!resourceId) {
    return res.status(400).json({ error: 'resourceId is required' });
  }

  try {
    if (resourceType === 'user_self') {
      if (resourceId !== String(req.user.id)) {
        return res.status(400).json({
          error: 'user_self requests must use your own user id as resourceId',
        });
      }
      if (action === 'edit') {
        const username = payload && (payload.username ?? payload.Username);
        if (!username || String(username).trim().length < 3) {
          return res.status(400).json({
            error: 'payload.username required (min 3 chars) for profile edit',
          });
        }
      }
    }

    if (resourceType === 'transaction') {
      const tid = parseInt(resourceId, 10);
      if (!Number.isInteger(tid) || tid < 1) {
        return res.status(400).json({ error: 'Invalid transaction id' });
      }
      const txn = await Transaction.getById(tid);
      if (!txn) {
        return res.status(404).json({ error: 'Transaction not found' });
      }
      if (txn.created_by != null && Number(txn.created_by) !== Number(req.user.id)) {
        return res.status(403).json({ error: 'You can only request changes for your own transactions' });
      }
      if (action === 'edit') {
        const required = ['date', 'type', 'amount', 'paymentType'];
        const p = payload && typeof payload === 'object' ? payload : {};
        for (const k of required) {
          if (p[k] === undefined || p[k] === null) {
            return res.status(400).json({ error: `payload.${k} is required for edit` });
          }
        }
      }
    }

    if (resourceType === 'payables_category') {
      const cid = parseInt(resourceId, 10);
      if (!Number.isInteger(cid) || cid < 1) {
        return res.status(400).json({ error: 'Invalid payables category id' });
      }
      const row = await PayablesCategory.getById(cid);
      if (!row) return res.status(404).json({ error: 'Payables category not found' });
      if (action === 'edit') {
        const name = payload && (payload.name ?? payload.Name);
        if (!name || String(name).trim() === '') {
          return res.status(400).json({ error: 'payload.name is required for edit' });
        }
      }
    }

    if (resourceType === 'receivables_category') {
      const cid = parseInt(resourceId, 10);
      if (!Number.isInteger(cid) || cid < 1) {
        return res.status(400).json({ error: 'Invalid receivables category id' });
      }
      const row = await ReceivablesCategory.getById(cid);
      if (!row) return res.status(404).json({ error: 'Receivables category not found' });
      if (action === 'edit') {
        const name = payload && (payload.name ?? payload.Name);
        if (!name || String(name).trim() === '') {
          return res.status(400).json({ error: 'payload.name is required for edit' });
        }
      }
    }

    const created = await ChangeRequest.create({
      requesterId: req.user.id,
      action,
      resourceType,
      resourceId,
      payload: payload && typeof payload === 'object' ? payload : null,
      requestNote: note ? String(note).trim() : null,
    });

    changeRequestEvents.emit('new_request', {
      requestId: created.id,
      action,
      resourceType,
      resourceId,
      requesterId: req.user.id,
      requesterUsername: req.user.username,
      note: note || null,
      status: 'pending',
    });

    return res.status(201).json({
      message: 'Request submitted; waiting for admin approval',
      request: created,
    });
  } catch (error) {
    console.error('submitChangeRequest:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function listMyChangeRequests(req, res) {
  try {
    const list = await ChangeRequest.listForRequester(req.user.id);
    return res.json({ requests: list });
  } catch (error) {
    console.error('listMyChangeRequests:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  submitChangeRequest,
  listMyChangeRequests,
};
