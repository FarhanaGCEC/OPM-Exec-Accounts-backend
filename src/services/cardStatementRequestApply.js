const path = require('path');
const fs = require('fs').promises;
const Statement = require('../models/Statement');
const StatementService = require('../services/statementService');
const {
  destroyStatementPdf,
  isCloudinaryConfigured,
} = require('../services/cloudinaryStatementUpload');
const {
  normalizeStatementAmount,
  parseStatementDateInput,
} = require('../utils/statementPatchParse');

const LEGACY_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'card-statements');

async function resolveCardStatementRow(resourceId, payload) {
  const month =
    payload && (payload.statementMonth || payload.statement_month || payload.month);
  let row = await Statement.getById(resourceId);
  if (row) return row;
  if (!month || !/^\d{4}-\d{2}$/.test(String(month))) {
    throw new Error(
      'Statement not found. Use statement row UUID as resourceId, or credit card UUID with payload.statementMonth (YYYY-MM)'
    );
  }
  row = await Statement.getByCardIdAndMonth(resourceId, String(month));
  if (!row) throw new Error('Statement not found for this card and month');
  return row;
}

/**
 * Build StatementService.updateStatement fields (same date/amount rules as PATCH).
 */
function statementPayloadToUpdateData(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const p = payload;
  const u = {};
  const sd = p.statement_date ?? p.statementDate;
  const dd = p.due_date ?? p.dueDate;
  if (sd != null && sd !== '') {
    const parsed = parseStatementDateInput(sd);
    if (!parsed.ok) {
      throw new Error(
        'Invalid statement_date. Use YYYY-MM-DD, DD/MM/YYYY, or DD-MM-YY (same as statement PATCH).'
      );
    }
    u.statement_date = parsed.value;
  }
  if (dd != null && dd !== '') {
    const parsed = parseStatementDateInput(dd);
    if (!parsed.ok) {
      throw new Error(
        'Invalid due_date. Use YYYY-MM-DD, DD/MM/YYYY, or DD-MM-YY (same as statement PATCH).'
      );
    }
    u.due_date = parsed.value;
  }
  const dm = p.due_month ?? p.dueMonth;
  if (dm != null && dm !== '') u.due_month = dm;
  const td = p.total_due ?? p.totalDue ?? p.total_payment_due ?? p.totalPaymentDue;
  const pa = p.paid_amount ?? p.paidAmount ?? p.paid;
  const ep = p.epp_balance ?? p.eppBalance ?? p.epp;
  const bt = p.balance_transfer ?? p.balanceTransfer;
  if (td !== undefined && td !== null && td !== '') {
    const n = normalizeStatementAmount(td);
    if (Number.isNaN(n) || n < 0) throw new Error('total_due must be a valid number >= 0');
    u.total_due = n;
  }
  if (pa !== undefined && pa !== null && pa !== '') {
    const n = normalizeStatementAmount(pa);
    if (Number.isNaN(n) || n < 0) throw new Error('paid_amount must be a valid number >= 0');
    u.paid_amount = n;
  }
  if (ep !== undefined && ep !== null && ep !== '') {
    const n = normalizeStatementAmount(ep);
    if (Number.isNaN(n) || n < 0) throw new Error('epp_balance must be a valid number >= 0');
    u.epp_balance = n;
  }
  if (bt !== undefined && bt !== null && bt !== '') {
    const n = normalizeStatementAmount(bt);
    if (Number.isNaN(n) || n < 0) throw new Error('balance_transfer must be a valid number >= 0');
    u.balance_transfer = n;
  }
  return u;
}

function payloadHasRemoveAttachment(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return payload.removeAttachment === true || payload.remove_attachment === true;
}

async function clearStatementAttachmentRow(row) {
  if (row.attachment_cloudinary_public_id && isCloudinaryConfigured()) {
    await destroyStatementPdf(row.attachment_cloudinary_public_id);
  }
  if (row.attachment_storage_key) {
    const absPath = path.join(LEGACY_UPLOAD_DIR, row.attachment_storage_key);
    try {
      await fs.unlink(absPath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  await Statement.update(row.id, {
    attachmentName: null,
    attachmentStorageKey: null,
    attachmentUrl: null,
    attachmentCloudinaryPublicId: null,
  });
}

/**
 * Apply approved card_statement change request. resourceId = statement UUID or credit card UUID (+ month in payload).
 */
async function applyApprovedCardStatementRequest({ action, resourceId, payload }) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const row = await resolveCardStatementRow(resourceId, p);

  if (action === 'delete') {
    await clearStatementAttachmentRow(row);
    return;
  }

  if (action === 'edit') {
    const removeAtt = payloadHasRemoveAttachment(p);
    const updateData = statementPayloadToUpdateData(p);
    if (!removeAtt && Object.keys(updateData).length === 0) {
      throw new Error('edit requires statement fields in payload or removeAttachment: true');
    }
    if (Object.keys(updateData).length > 0) {
      await StatementService.updateStatement(row.id, updateData);
    }
    if (removeAtt) {
      const fresh = await Statement.getById(row.id);
      await clearStatementAttachmentRow(fresh);
    }
    return;
  }

  throw new Error(`Unsupported action for card_statement: ${action}`);
}

module.exports = {
  resolveCardStatementRow,
  statementPayloadToUpdateData,
  payloadHasRemoveAttachment,
  applyApprovedCardStatementRequest,
};
