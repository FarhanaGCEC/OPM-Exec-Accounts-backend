const path = require('path');
const fs = require('fs').promises;
const Statement = require('../models/Statement');
const Card = require('../models/Card');
const StatementService = require('../services/statementService');
const {
  destroyStatementPdf,
  isCloudinaryConfigured,
} = require('../services/cloudinaryStatementUpload');
const {
  normalizeStatementAmount,
  parseStatementDateInput,
} = require('../utils/statementPatchParse');
const {
  payloadHasStatementAttachment,
  applyStatementAttachmentToRow,
} = require('../utils/statementPdfAttachment');

const LEGACY_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'card-statements');

function normalizeResourceId(resourceId) {
  return String(resourceId || '').trim();
}

function normalizeStatementMonth(payload) {
  if (!payload || typeof payload !== 'object') return null;
  let raw = payload.statementMonth ?? payload.statement_month ?? payload.month;
  if (raw == null || raw === '') {
    const year = payload.year ?? payload.statementYear ?? payload.statement_year;
    const monthNum = payload.monthNum ?? payload.month_num;
    if (year != null && monthNum != null) {
      raw = `${year}-${String(monthNum).padStart(2, '0')}`;
    }
  }
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  const short = s.match(/^(\d{4})-(\d{1,2})$/);
  if (short) return `${short[1]}-${short[2].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  return null;
}

function cardIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const id =
    payload.credit_card_id ??
    payload.creditCardId ??
    payload.card_id ??
    payload.cardId;
  return id != null && String(id).trim() !== '' ? String(id).trim() : null;
}

/**
 * Resolve card + month (+ existing statement row if any) from change-request resourceId/payload.
 */
async function resolveCardStatementContext(resourceId, payload) {
  const rid = normalizeResourceId(resourceId);
  const p = payload && typeof payload === 'object' ? payload : {};
  const month = normalizeStatementMonth(p);

  let row = rid ? await Statement.getById(rid) : null;
  if (row) {
    return {
      row,
      cardId: row.credit_card_id,
      month: row.statement_month,
    };
  }

  if (rid && month) {
    row = await Statement.getByCardIdAndMonth(rid, month);
    if (row) {
      return { row, cardId: rid, month };
    }
    const card = await Card.getById(rid);
    if (card) {
      return { row: null, cardId: rid, month };
    }
  }

  const payloadCardId = cardIdFromPayload(p);
  if (payloadCardId && month) {
    row = await Statement.getByCardIdAndMonth(payloadCardId, month);
    if (row) {
      return { row, cardId: payloadCardId, month };
    }
    const card = await Card.getById(payloadCardId);
    if (card) {
      return { row: null, cardId: payloadCardId, month };
    }
  }

  if (!month) {
    throw new Error(
      'Statement not found. Use statement row UUID as resourceId, or credit card UUID with payload.statementMonth (YYYY-MM)'
    );
  }

  throw new Error(
    `Statement not found for this card and month (${month}). resourceId must be the credit card UUID from the statements list (card_id / credit_card_id), not a missing statement row id.`
  );
}

function defaultDueMonthLabel(dueDateYmd) {
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const [year, month] = String(dueDateYmd).split('-');
  return `${monthNames[parseInt(month, 10) - 1]} ${year}`;
}

function defaultStatementDatesForCard(card, month) {
  const billingCycleDays = card.billing_cycle_days || 25;
  const statementDay = card.statement_day || 1;
  const [year, monthNum] = month.split('-');
  const yearNum = parseInt(year, 10);
  const monthNumInt = parseInt(monthNum, 10);
  const daysInMonth = new Date(yearNum, monthNumInt, 0).getDate();
  const finalStatementDay = Math.min(statementDay, daysInMonth);
  const dayStr = String(finalStatementDay).padStart(2, '0');
  const monthStr = String(monthNumInt).padStart(2, '0');
  const defaultStatementDate = `${yearNum}-${monthStr}-${dayStr}`;

  const stmtDate = new Date(`${defaultStatementDate}T12:00:00`);
  stmtDate.setDate(stmtDate.getDate() + billingCycleDays);
  const dueYear = stmtDate.getFullYear();
  const dueMonth = String(stmtDate.getMonth() + 1).padStart(2, '0');
  const dueDay = String(stmtDate.getDate()).padStart(2, '0');
  const defaultDueDate = `${dueYear}-${dueMonth}-${dueDay}`;

  return {
    billingCycleDays,
    defaultStatementDate,
    defaultDueDate,
    defaultDueMonth: defaultDueMonthLabel(defaultDueDate),
  };
}

async function createStatementForCardMonth(cardId, month, payload, card = null) {
  const resolvedCard = card || (await Card.getById(cardId));
  if (!resolvedCard) {
    throw new Error('Card not found');
  }

  const existing = await Statement.getByCardIdAndMonth(cardId, month);
  if (existing) return existing;

  const p = payload && typeof payload === 'object' ? payload : {};
  const updateData = statementPayloadToUpdateData(p);
  const { billingCycleDays, defaultStatementDate, defaultDueDate, defaultDueMonth } =
    defaultStatementDatesForCard(resolvedCard, month);

  const finalStatementDate = updateData.statement_date || defaultStatementDate;
  const finalDueDate = updateData.due_date || defaultDueDate;
  const initTotalDue = updateData.total_due !== undefined ? updateData.total_due : 0;
  const initPaidAmount = updateData.paid_amount !== undefined ? updateData.paid_amount : 0;
  const initEppBalance = updateData.epp_balance !== undefined ? updateData.epp_balance : 0;
  const initBalanceTransfer =
    updateData.balance_transfer !== undefined ? updateData.balance_transfer : 0;
  const initPendingAmount = StatementService.calculatePendingAmount(
    initTotalDue,
    initPaidAmount,
    initEppBalance
  );
  const initPaymentStatus = StatementService.calculatePaymentStatus(
    initPendingAmount,
    finalDueDate
  );

  return Statement.create({
    creditCardId: cardId,
    statementMonth: month,
    statementDate: finalStatementDate,
    dueDate: finalDueDate,
    days: billingCycleDays,
    dueMonth: updateData.due_month || p.due_month || p.dueMonth || defaultDueMonth,
    totalDue: initTotalDue,
    paidAmount: initPaidAmount,
    eppBalance: initEppBalance,
    balanceTransfer: initBalanceTransfer,
    pendingAmount: initPendingAmount,
    paymentStatus: initPaymentStatus,
  });
}

/**
 * Validate target for queued change requests (no DB write).
 * Accepts existing statement UUID, or credit card UUID + payload.statementMonth even if the row is not created yet.
 */
async function validateCardStatementTarget(resourceId, payload) {
  const ctx = await resolveCardStatementContext(resourceId, payload);
  if (ctx.row) return ctx.row;
  return {
    credit_card_id: ctx.cardId,
    statement_month: ctx.month,
    id: null,
  };
}

/** Resolve statement row, auto-creating for card + month when needed (same as admin PATCH). */
async function ensureCardStatementRow(resourceId, payload) {
  const ctx = await resolveCardStatementContext(resourceId, payload);
  if (ctx.row) return ctx.row;
  return createStatementForCardMonth(ctx.cardId, ctx.month, payload);
}

async function resolveCardStatementRow(resourceId, payload) {
  return ensureCardStatementRow(resourceId, payload);
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
    if (Number.isNaN(n)) throw new Error('total_due must be a valid number (negative allowed for overpayment credit)');
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
  const row = await ensureCardStatementRow(resourceId, p);

  if (action === 'delete') {
    await clearStatementAttachmentRow(row);
    return;
  }

  if (action === 'edit') {
    const removeAtt = payloadHasRemoveAttachment(p);
    const hasAttach = payloadHasStatementAttachment(p);
    const updateData = statementPayloadToUpdateData(p);
    if (!removeAtt && Object.keys(updateData).length === 0 && !hasAttach) {
      throw new Error(
        'edit requires statement fields in payload, attachmentBase64 (PDF), or removeAttachment: true'
      );
    }
    if (removeAtt && hasAttach) {
      throw new Error('Cannot attach and remove statement PDF in the same request');
    }
    if (Object.keys(updateData).length > 0) {
      await StatementService.updateStatement(row.id, updateData);
    }
    if (hasAttach) {
      const fresh = await Statement.getById(row.id);
      const saveResult = await applyStatementAttachmentToRow(row.id, p, fresh);
      if (!saveResult.ok) {
        throw new Error(saveResult.error || 'Failed to save statement attachment');
      }
    } else if (removeAtt) {
      const fresh = await Statement.getById(row.id);
      await clearStatementAttachmentRow(fresh);
    }
    return;
  }

  throw new Error(`Unsupported action for card_statement: ${action}`);
}

module.exports = {
  validateCardStatementTarget,
  ensureCardStatementRow,
  resolveCardStatementRow,
  statementPayloadToUpdateData,
  payloadHasRemoveAttachment,
  applyApprovedCardStatementRequest,
};
