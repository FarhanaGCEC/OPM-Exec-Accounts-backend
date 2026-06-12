const Transaction = require('../models/Transaction');
const ChangeRequest = require('../models/ChangeRequest');
const PayablesCategory = require('../models/PayablesCategory');
const ReceivablesCategory = require('../models/ReceivablesCategory');
const PurchaseBill = require('../models/PurchaseBill');
const CreditCardPayment = require('../models/CreditCardPayment');
const changeRequestEvents = require('../services/changeRequestEvents');
const { USER_ROLES } = require('../constants/roles');
const User = require('../models/User');
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
} = require('../utils/statementPdfAttachment');
const { payloadToPurchaseBillUpdate } = require('../utils/purchaseBillPayload');
const { payloadToCreditCardPaymentUpdate } = require('../utils/creditCardPaymentPayload');
const {
  normalizeTransactionEditPayload,
  assertTransactionEditRequired,
} = require('../utils/transactionChangePayload');
const { validateAndBuildPdcUpdate } = require('../utils/pdcChangeRequestPayload');
const PDC = require('../models/PDC');
const { CHANGE_REQUEST_RESOURCE_TYPES } = require('../constants/changeRequestResourceTypes');

const ALLOWED_TYPES = new Set(CHANGE_REQUEST_RESOURCE_TYPES);

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
      if (req.user.role === USER_ROLES.USER) {
        const dbUser = await User.findById(req.user.id);
        if (!dbUser) {
          return res.status(401).json({ error: 'User not found' });
        }
        const perms = effectiveSidebarPermissions(dbUser.role, dbUser.sidebarPermissionsStored);
        if (!perms.daily_transactions) {
          return res.status(403).json({
            code: 'SIDEBAR_PERMISSION_REQUIRED',
            error: 'Daily Transactions access is required to submit transaction change requests.',
          });
        }
      }
      if (action === 'edit') {
        try {
          const norm = normalizeTransactionEditPayload(payload || {});
          assertTransactionEditRequired(norm);
        } catch (e) {
          return res.status(400).json({
            error: e.message,
            hint: 'Use payment_type or paymentType, category_id or categoryId, cheque_number or chequeNumber.',
          });
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

    if (resourceType === 'card_statement') {
      if (req.user.role === USER_ROLES.USER) {
        const dbUser = await User.findById(req.user.id);
        if (!dbUser) {
          return res.status(401).json({ error: 'User not found' });
        }
        const perms = effectiveSidebarPermissions(dbUser.role, dbUser.sidebarPermissionsStored);
        if (!perms.credit_cards) {
          return res.status(403).json({
            code: 'SIDEBAR_PERMISSION_REQUIRED',
            error: 'Credit Cards access is required to request statement changes.',
          });
        }
      }
      try {
        await validateCardStatementTarget(
          resourceId,
          payload && typeof payload === 'object' ? payload : {}
        );
      } catch (e) {
        return res.status(400).json({
          error: e.message || 'Invalid card_statement target (need statement id or card id + payload.statementMonth)',
        });
      }
      if (action === 'edit') {
        const p = payload && typeof payload === 'object' ? payload : {};
        let updateKeys;
        try {
          updateKeys = statementPayloadToUpdateData(p);
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
        const hasAttach = payloadHasStatementAttachment(p);
        const removeAtt = payloadHasRemoveAttachment(p);
        if (removeAtt && hasAttach) {
          return res.status(400).json({
            error: 'Cannot attach and remove statement PDF in the same request',
          });
        }
        if (!removeAtt && Object.keys(updateKeys).length === 0 && !hasAttach) {
          return res.status(400).json({
            error:
              'For card_statement edit, payload must include fields (e.g. total_due, paid_amount, statement_date as YYYY-MM-DD), attachmentBase64 (PDF), and/or removeAttachment: true',
          });
        }
        if (hasAttach) {
          const decoded = decodeStatementPdfBase64FromPayload(p);
          if (decoded && decoded.error) {
            return res.status(400).json({ error: decoded.error });
          }
        }
      }
    }

    if (resourceType === 'purchase_bill') {
      const pid = parseInt(resourceId, 10);
      if (!Number.isInteger(pid) || pid < 1) {
        return res.status(400).json({ error: 'Invalid purchase bill id' });
      }
      const billRow = await PurchaseBill.getById(pid);
      if (!billRow) {
        return res.status(404).json({ error: 'Purchase bill not found' });
      }
      if (req.user.role === USER_ROLES.USER) {
        const dbUser = await User.findById(req.user.id);
        if (!dbUser) {
          return res.status(401).json({ error: 'User not found' });
        }
        const perms = effectiveSidebarPermissions(dbUser.role, dbUser.sidebarPermissionsStored);
        if (!perms.credit_cards) {
          return res.status(403).json({
            code: 'SIDEBAR_PERMISSION_REQUIRED',
            error: 'Credit Cards access is required to request purchase bill changes.',
          });
        }
        if (billRow.created_by != null && Number(billRow.created_by) !== Number(req.user.id)) {
          return res.status(403).json({
            error: 'You can only request changes for purchase bills you created',
          });
        }
      }
      if (action === 'edit') {
        try {
          const keys = payloadToPurchaseBillUpdate(payload || {}, { requireBillDateAndAmount: false });
          if (Object.keys(keys).length === 0) {
            return res.status(400).json({
              error:
                'For purchase_bill edit, include at least one of: bill_date, amount, invoice_number, vendor_name, bill_number, payment_method, description, payment_status',
            });
          }
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
      }
    }

    if (resourceType === 'credit_card_payment') {
      const pid = parseInt(resourceId, 10);
      if (!Number.isInteger(pid) || pid < 1) {
        return res.status(400).json({ error: 'Invalid credit card payment id' });
      }
      const paymentRow = await CreditCardPayment.getById(pid);
      if (!paymentRow) {
        return res.status(404).json({ error: 'Credit card payment not found' });
      }
      if (req.user.role === USER_ROLES.USER) {
        const dbUser = await User.findById(req.user.id);
        if (!dbUser) {
          return res.status(401).json({ error: 'User not found' });
        }
        const perms = effectiveSidebarPermissions(dbUser.role, dbUser.sidebarPermissionsStored);
        if (!perms.customer_credit_card_payments && !perms.credit_cards) {
          return res.status(403).json({
            code: 'SIDEBAR_PERMISSION_REQUIRED',
            error:
              'Customer Credit Card Payments or Credit Cards access is required to request payment changes.',
          });
        }
        if (
          paymentRow.created_by != null &&
          Number(paymentRow.created_by) !== Number(req.user.id)
        ) {
          return res.status(403).json({
            error: 'You can only request changes for credit card payments you created',
          });
        }
      }
      if (action === 'edit') {
        try {
          const keys = payloadToCreditCardPaymentUpdate(payload || {}, {
            requirePaymentDateAndAmount: false,
          });
          if (Object.keys(keys).length === 0) {
            return res.status(400).json({
              error:
                'For credit_card_payment edit, include at least one of: payment_date, amount, credit_card_id, card_holder, remarks, paid_against',
            });
          }
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
      }
    }

    if (resourceType === 'post_dated_cheque') {
      const pid = parseInt(resourceId, 10);
      if (!Number.isInteger(pid) || pid < 1) {
        return res.status(400).json({ error: 'Invalid post-dated cheque id' });
      }
      const pdcRow = await PDC.getById(pid);
      if (!pdcRow) {
        return res.status(404).json({ error: 'Post-dated cheque not found' });
      }
      if (req.user.role === USER_ROLES.USER) {
        const dbUser = await User.findById(req.user.id);
        if (!dbUser) {
          return res.status(401).json({ error: 'User not found' });
        }
        const perms = effectiveSidebarPermissions(dbUser.role, dbUser.sidebarPermissionsStored);
        if (!perms.post_dated_cheques) {
          return res.status(403).json({
            code: 'SIDEBAR_PERMISSION_REQUIRED',
            error: 'Post-Dated Cheques access is required.',
          });
        }
        if (pdcRow.created_by != null && Number(pdcRow.created_by) !== Number(req.user.id)) {
          return res.status(403).json({
            error: 'You can only request changes for PDCs you created',
          });
        }
      }
      if (action === 'edit') {
        const built = validateAndBuildPdcUpdate(payload || {});
        if (!built.ok) {
          return res.status(400).json({
            error: built.error,
            ...(built.missingFields && { missingFields: built.missingFields }),
          });
        }
      }
    }

    let storedPayload = payload && typeof payload === 'object' ? { ...payload } : null;
    if (resourceType === 'card_statement' && storedPayload && action === 'edit') {
      try {
        storedPayload = await stageStatementAttachmentInPayload(storedPayload, {
          requesterId: req.user.id,
        });
      } catch (e) {
        return res.status(400).json({ error: e.message || 'Failed to stage statement attachment' });
      }
    }

    const created = await ChangeRequest.create({
      requesterId: req.user.id,
      action,
      resourceType,
      resourceId,
      payload: storedPayload,
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
    const requesterId = Number(req.user.id);
    const payload = {
      success: true,
      requests: list,
      changeRequests: list,
      meta: {
        requesterId,
        username: req.user.username,
        role: req.user.role,
      },
    };
    if (
      list.length === 0 &&
      (req.user.role === USER_ROLES.ADMIN || req.user.role === USER_ROLES.ACCOUNTANT)
    ) {
      payload.hint =
        'This route only lists change requests that you submitted yourself. To review everyone’s pending requests as an admin, use GET /api/admin/change-requests.';
    }
    return res.json(payload);
  } catch (error) {
    console.error('listMyChangeRequests:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  submitChangeRequest,
  listMyChangeRequests,
};
