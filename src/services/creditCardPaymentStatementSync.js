const Card = require('../models/Card');
const Statement = require('../models/Statement');
const CardStatementPayment = require('../models/CardStatementPayment');
const CardStatementEpp = require('../models/CardStatementEpp');
const CreditCardPayment = require('../models/CreditCardPayment');
const StatementService = require('./statementService');
const { roundToTwoDecimals } = require('../utils/formatAmount');

const CCP_NOTE_PREFIX = 'ccp:';
const LEGACY_HEADER_NOTE = 'legacy:header';

function paymentLinkNote(paymentId) {
  return `${CCP_NOTE_PREFIX}${paymentId}`;
}

function parsePaymentIdFromNote(note) {
  const s = String(note || '').trim();
  const m = /^ccp:(\d+)$/i.exec(s);
  if (!m) return null;
  const id = parseInt(m[1], 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isLegacyHeaderNote(note) {
  return String(note || '').trim().toLowerCase() === LEGACY_HEADER_NOTE;
}

function toYmd(d) {
  if (d == null) return null;
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const s = String(d);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function monthFromYmd(ymd) {
  if (!ymd || typeof ymd !== 'string' || ymd.length < 7) return null;
  return ymd.slice(0, 7);
}

function fallbackPaidAtForMonth(statementMonth) {
  return `${statementMonth}-01`;
}

function rowsToEntries(rows, statementMonth, excludePaymentId) {
  const note = excludePaymentId != null ? paymentLinkNote(excludePaymentId) : null;
  const entries = [];
  for (const row of rows || []) {
    if (note && String(row.note || '') === note) continue;
    const amount = roundToTwoDecimals(row.amount);
    if (!Number.isFinite(amount) || amount < 0) continue;
    const paidAt = toYmd(row.paid_at) || fallbackPaidAtForMonth(statementMonth);
    entries.push({
      amount,
      paid_at: paidAt,
      note: row.note != null && String(row.note).trim() !== '' ? String(row.note).trim() : null,
    });
  }
  return entries;
}

function sumAmounts(entries) {
  return roundToTwoDecimals(
    (entries || []).reduce((acc, e) => acc + (Number(e.amount) || 0), 0)
  );
}

function rowMatchesPayment(row, paymentId) {
  return String(row.note || '') === paymentLinkNote(paymentId);
}

/**
 * Collect linked credit_card_payment ids currently referenced on a statement.
 */
async function collectLinkedPaymentIds(statementId) {
  const [paidRows, eppRows] = await Promise.all([
    CardStatementPayment.listByStatementId(statementId),
    CardStatementEpp.listByStatementId(statementId),
  ]);
  const ids = new Set();
  for (const row of [...paidRows, ...eppRows]) {
    const id = parsePaymentIdFromNote(row.note);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Ensure a statement row exists for card + YYYY-MM (create with defaults if missing).
 */
async function ensureStatementForCardMonth(cardId, statementMonth) {
  const existing = await Statement.getByCardIdAndMonth(cardId, statementMonth);
  if (existing) return existing;

  const card = await Card.getById(cardId);
  if (!card) {
    throw new Error('Credit card not found for statement sync');
  }

  const billingCycleDays = card.billing_cycle_days || 25;
  const statementDay = card.statement_day || 1;
  const [year, monthNum] = statementMonth.split('-');
  const yearNum = parseInt(year, 10);
  const monthNumInt = parseInt(monthNum, 10);
  const daysInMonth = new Date(yearNum, monthNumInt, 0).getDate();
  const finalStatementDay = Math.min(statementDay, daysInMonth);
  const dayStr = String(finalStatementDay).padStart(2, '0');
  const monthStr = String(monthNumInt).padStart(2, '0');
  const statementDate = `${yearNum}-${monthStr}-${dayStr}`;

  const stmtDate = new Date(`${statementDate}T12:00:00`);
  stmtDate.setDate(stmtDate.getDate() + billingCycleDays);
  const dueYear = stmtDate.getFullYear();
  const dueMonth = String(stmtDate.getMonth() + 1).padStart(2, '0');
  const dueDay = String(stmtDate.getDate()).padStart(2, '0');
  const dueDate = `${dueYear}-${dueMonth}-${dueDay}`;

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const dueMonthStr = `${monthNames[parseInt(dueMonth, 10) - 1]} ${dueYear}`;

  return Statement.create({
    creditCardId: cardId,
    statementMonth,
    statementDate,
    dueDate,
    days: billingCycleDays,
    dueMonth: dueMonthStr,
    totalDue: 0,
    paidAmount: 0,
    eppBalance: 0,
    balanceTransfer: 0,
    minPaymentDue: 0,
    pendingAmount: 0,
    paymentStatus: 'PARTIAL',
  });
}

/**
 * Rewrite paid/epp breakdown for a payment link.
 * Uses _skipCreditCardPaymentSync to avoid payment ↔ statement loops.
 *
 * @param {string} statementId
 * @param {string|number} paymentId
 * @param {string} statementMonth
 * @param {{ type: 'paid'|'epp', amount: number, paid_at: string }|null} addEntry
 */
async function rewriteStatementBreakdown(statementId, paymentId, statementMonth, addEntry) {
  const stmt = await Statement.getById(statementId);
  if (!stmt) throw new Error('Statement not found for payment sync');

  const [paidRows, eppRows] = await Promise.all([
    CardStatementPayment.listByStatementId(statementId),
    CardStatementEpp.listByStatementId(statementId),
  ]);

  const hadOurPaid = paidRows.some((r) => rowMatchesPayment(r, paymentId));
  const hadOurEpp = eppRows.some((r) => rowMatchesPayment(r, paymentId));

  let payments = rowsToEntries(paidRows, statementMonth, paymentId);
  let eppPayments = rowsToEntries(eppRows, statementMonth, paymentId);

  if (addEntry) {
    const entry = {
      amount: roundToTwoDecimals(addEntry.amount),
      paid_at: addEntry.paid_at,
      note: paymentLinkNote(paymentId),
    };
    if (addEntry.type === 'epp') {
      if (eppRows.length === 0 && !hadOurEpp) {
        const headerEpp = roundToTwoDecimals(stmt.epp_balance) || 0;
        if (headerEpp > 0) {
          eppPayments.unshift({
            amount: headerEpp,
            paid_at: fallbackPaidAtForMonth(statementMonth),
            note: LEGACY_HEADER_NOTE,
          });
        }
      }
      eppPayments.push(entry);
    } else {
      if (paidRows.length === 0 && !hadOurPaid) {
        const headerPaid = roundToTwoDecimals(stmt.paid_amount) || 0;
        if (headerPaid > 0) {
          payments.unshift({
            amount: headerPaid,
            paid_at: fallbackPaidAtForMonth(statementMonth),
            note: LEGACY_HEADER_NOTE,
          });
        }
      }
      payments.push(entry);
    }
  }

  const touchPaid =
    hadOurPaid ||
    (addEntry && addEntry.type === 'paid') ||
    paidRows.length > 0;
  const touchEpp =
    hadOurEpp ||
    (addEntry && addEntry.type === 'epp') ||
    eppRows.length > 0;

  if (!touchPaid && !touchEpp) return;

  const updateData = { _skipCreditCardPaymentSync: true };
  if (touchPaid) {
    updateData.payments = payments;
    updateData.paid_amount = sumAmounts(payments);
  }
  if (touchEpp) {
    updateData.epp_payments = eppPayments;
    updateData.epp_balance = sumAmounts(eppPayments);
  }

  await StatementService.updateStatement(statementId, updateData);
}

/**
 * Statement → credit_card_payments (after paid/epp breakdown change).
 * Entries linked via note `ccp:{id}` are updated; new rows create payments and rewrite notes.
 * Removed `ccp:` links delete the corresponding credit card payments.
 *
 * @param {{ statementId: string, previousLinkedIds?: number[], cardId?: string }} opts
 */
async function syncStatementBreakdownToPayments(opts) {
  const statementId = opts && opts.statementId;
  if (!statementId) return;

  const stmt = await Statement.getById(statementId);
  if (!stmt) return;

  const cardId = opts.cardId || stmt.credit_card_id || stmt.card_id || null;
  if (!cardId) return;

  const previousLinkedIds = Array.isArray(opts.previousLinkedIds) ? opts.previousLinkedIds : [];
  const statementMonth = stmt.statement_month || null;

  const [paidRows, eppRows] = await Promise.all([
    CardStatementPayment.listByStatementId(statementId),
    CardStatementEpp.listByStatementId(statementId),
  ]);

  const kept = new Set();
  let needsRewrite = false;

  async function processBucket(rows, paymentType) {
    const out = [];
    for (const row of rows || []) {
      const amount = roundToTwoDecimals(row.amount);
      if (!Number.isFinite(amount) || amount < 0) continue;

      const paidAt =
        toYmd(row.paid_at) ||
        (statementMonth ? fallbackPaidAtForMonth(statementMonth) : null);
      if (!paidAt) continue;

      const rawNote =
        row.note != null && String(row.note).trim() !== '' ? String(row.note).trim() : null;

      if (isLegacyHeaderNote(rawNote)) {
        out.push({ amount, paid_at: paidAt, note: LEGACY_HEADER_NOTE });
        continue;
      }

      const linkedId = parsePaymentIdFromNote(rawNote);
      if (linkedId) {
        const existing = await CreditCardPayment.getById(linkedId);
        if (existing) {
          await CreditCardPayment.update(linkedId, {
            paymentDate: paidAt,
            creditCardId: cardId,
            amount,
            paymentType,
          });
          kept.add(linkedId);
          out.push({ amount, paid_at: paidAt, note: paymentLinkNote(linkedId) });
          continue;
        }
      }

      const created = await CreditCardPayment.create({
        paymentDate: paidAt,
        creditCardId: cardId,
        customerName: stmt.card_holder || null,
        paymentMethod: 'Credit Card',
        paymentType,
        amount,
        remarks: linkedId ? null : rawNote,
        paidAgainst: null,
        createdBy: null,
      });
      kept.add(created.id);
      needsRewrite = true;
      out.push({ amount, paid_at: paidAt, note: paymentLinkNote(created.id) });
    }
    return out;
  }

  const newPaid = await processBucket(paidRows, 'paid');
  const newEpp = await processBucket(eppRows, 'epp');

  if (needsRewrite) {
    await StatementService.updateStatement(statementId, {
      payments: newPaid,
      epp_payments: newEpp,
      paid_amount: sumAmounts(newPaid),
      epp_balance: sumAmounts(newEpp),
      _skipCreditCardPaymentSync: true,
    });
  }

  for (const id of previousLinkedIds) {
    if (kept.has(id)) continue;
    try {
      await CreditCardPayment.delete(id);
    } catch (err) {
      console.error('Failed to delete orphaned credit card payment after statement sync:', id, err);
    }
  }
}

/**
 * Remove a credit-card payment's linked paid/epp row from its statement month (if any).
 */
async function removePaymentFromStatement(payment) {
  if (!payment || payment.id == null) return;
  const cardId = payment.credit_card_id || payment.card_id || null;
  const ymd = toYmd(payment.payment_date);
  const month = monthFromYmd(ymd);
  if (!cardId || !month) return;

  const stmt = await Statement.getByCardIdAndMonth(cardId, month);
  if (!stmt) return;

  const [paidRows, eppRows] = await Promise.all([
    CardStatementPayment.listByStatementId(stmt.id),
    CardStatementEpp.listByStatementId(stmt.id),
  ]);
  const linked = [...paidRows, ...eppRows].some((r) => rowMatchesPayment(r, payment.id));
  if (!linked) return;

  await rewriteStatementBreakdown(stmt.id, payment.id, month, null);
}

/**
 * Apply (upsert) a credit-card payment onto the card statement paid or epp section.
 */
async function applyPaymentToStatement(payment) {
  if (!payment || payment.id == null) return;
  const cardId = payment.credit_card_id || payment.card_id || null;
  const ymd = toYmd(payment.payment_date);
  const month = monthFromYmd(ymd);
  if (!cardId || !month) return;

  const amount = roundToTwoDecimals(payment.amount);
  if (!Number.isFinite(amount) || amount <= 0) return;

  const type = String(payment.payment_type || 'paid').trim().toLowerCase() === 'epp' ? 'epp' : 'paid';
  const stmt = await ensureStatementForCardMonth(cardId, month);

  await rewriteStatementBreakdown(stmt.id, payment.id, month, {
    type,
    amount,
    paid_at: ymd,
  });
}

async function syncPaymentCreated(payment) {
  await applyPaymentToStatement(payment);
}

async function syncPaymentUpdated(previousPayment, nextPayment) {
  const prevCard = previousPayment
    ? previousPayment.credit_card_id || previousPayment.card_id || null
    : null;
  const nextCard = nextPayment
    ? nextPayment.credit_card_id || nextPayment.card_id || null
    : null;
  const prevMonth = previousPayment ? monthFromYmd(toYmd(previousPayment.payment_date)) : null;
  const nextMonth = nextPayment ? monthFromYmd(toYmd(nextPayment.payment_date)) : null;

  const sameTarget =
    prevCard &&
    nextCard &&
    prevCard === nextCard &&
    prevMonth &&
    nextMonth &&
    prevMonth === nextMonth;

  if (previousPayment && !sameTarget) {
    await removePaymentFromStatement(previousPayment);
  }
  await applyPaymentToStatement(nextPayment);
}

async function syncPaymentDeleted(payment) {
  await removePaymentFromStatement(payment);
}

module.exports = {
  paymentLinkNote,
  LEGACY_HEADER_NOTE,
  collectLinkedPaymentIds,
  syncStatementBreakdownToPayments,
  syncPaymentCreated,
  syncPaymentUpdated,
  syncPaymentDeleted,
  applyPaymentToStatement,
  removePaymentFromStatement,
};
