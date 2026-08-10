const Card = require('../models/Card');
const Statement = require('../models/Statement');
const CardStatementPayment = require('../models/CardStatementPayment');
const CardStatementEpp = require('../models/CardStatementEpp');
const CreditCardPayment = require('../models/CreditCardPayment');
const StatementService = require('./statementService');
const { roundToTwoDecimals } = require('../utils/formatAmount');

const CCP_NOTE_PREFIX = 'ccp:';
const LEGACY_HEADER_NOTE = 'legacy:header';
/** Default remarks when a paid partial is created from a card statement. */
const DEFAULT_PAID_REMARKS = 'GCEC Cloud';

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

function pad2(n) {
  return String(n).padStart(2, '0');
}

function shiftCalendarMonth(year, month /* 1–12 */, delta) {
  const dt = new Date(year, month - 1 + delta, 1);
  return { year: dt.getFullYear(), month: dt.getMonth() + 1 };
}

/**
 * Map payment date → statement_month (YYYY-MM) using the card's statement_day.
 *
 * Cycle for statement month M (example statement_day = 19):
 *   July  (2026-07): 20-Jul .. 19-Aug  (statement dated 19-Jul covers through next stmt day)
 *   August(2026-08): 20-Aug .. 19-Sep
 * Payment ON a statement day closes the prior cycle (19-Aug → July, 20-Aug → August).
 *
 * Examples (statement_day = 19, SCB):
 *   2026-07-19 → 2026-06
 *   2026-07-20 .. 2026-08-19 → 2026-07
 *   2026-08-20 .. 2026-09-19 → 2026-08
 * Examples (statement_day = 2, DEEM):
 *   2026-08-02 → 2026-07
 *   2026-08-03 .. 2026-09-02 → 2026-08
 * Examples (statement_day = 8, CBD):
 *   2026-08-08 → 2026-07
 *   2026-08-09 .. 2026-09-08 → 2026-08
 */
function statementMonthForPaymentDate(paymentYmd, statementDay) {
  if (!paymentYmd || typeof paymentYmd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(paymentYmd)) {
    return null;
  }
  const y = parseInt(paymentYmd.slice(0, 4), 10);
  const m = parseInt(paymentYmd.slice(5, 7), 10);
  const d = parseInt(paymentYmd.slice(8, 10), 10);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;

  let day = parseInt(statementDay, 10);
  if (!Number.isInteger(day) || day < 1) day = 1;
  if (day > 31) day = 31;

  const daysInThisMonth = new Date(y, m, 0).getDate();
  const thisMonthStmtDay = Math.min(day, daysInThisMonth);

  // Inclusive end: on/before this month's statement day → previous statement month
  // e.g. day=19: Aug 19 still July; Aug 20 starts August
  if (d <= thisMonthStmtDay) {
    const prev = shiftCalendarMonth(y, m, -1);
    return `${prev.year}-${pad2(prev.month)}`;
  }
  return `${y}-${pad2(m)}`;
}

async function resolveStatementMonthForPayment(payment) {
  const ymd = toYmd(payment && payment.payment_date);
  const cardId = payment ? payment.credit_card_id || payment.card_id || null : null;
  if (!ymd) return { ymd: null, month: null, cardId };

  let statementDay = 1;
  if (cardId) {
    const card = await Card.getById(cardId);
    if (card && card.statement_day != null && card.statement_day !== '') {
      statementDay = card.statement_day;
    }
  }

  const month =
    statementMonthForPaymentDate(ymd, statementDay) || monthFromYmd(ymd);
  return { ymd, month, cardId };
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
          eppPayments.push({
            amount: headerEpp,
            paid_at: fallbackPaidAtForMonth(statementMonth),
            note: LEGACY_HEADER_NOTE,
          });
        }
      }
      // Latest first (sort_order 0)
      eppPayments.unshift(entry);
    } else {
      if (paidRows.length === 0 && !hadOurPaid) {
        const headerPaid = roundToTwoDecimals(stmt.paid_amount) || 0;
        if (headerPaid > 0) {
          payments.push({
            amount: headerPaid,
            paid_at: fallbackPaidAtForMonth(statementMonth),
            note: LEGACY_HEADER_NOTE,
          });
        }
      }
      // Latest first (sort_order 0)
      payments.unshift(entry);
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
 * Partition statement paid/epp rows into those that belong on this statement_month
 * vs those whose paid_at falls in a *later* statement cycle (forward rehome only).
 * Legacy header rows always stay put.
 */
function partitionRowsByStatementMonth(rows, statementMonth, statementDay) {
  const keep = [];
  /** @type {Map<string, Array<{ amount: number, paid_at: string, note: string|null }>>} */
  const moves = new Map();
  /** @type {Set<number>} */
  const movedPaymentIds = new Set();

  for (const row of rows || []) {
    const amount = roundToTwoDecimals(row.amount);
    if (!Number.isFinite(amount) || amount < 0) continue;

    const paidAt =
      toYmd(row.paid_at) ||
      (statementMonth ? fallbackPaidAtForMonth(statementMonth) : null);
    if (!paidAt) continue;

    const note =
      row.note != null && String(row.note).trim() !== ''
        ? String(row.note).trim()
        : null;
    const entry = { amount, paid_at: paidAt, note };

    if (isLegacyHeaderNote(note)) {
      keep.push(entry);
      continue;
    }

    const targetMonth =
      statementMonthForPaymentDate(paidAt, statementDay) || statementMonth;
    // Only move forward (e.g. Jul statement + Aug-24 → August).
    // Do not pull older-cycle dates backward off this statement.
    if (!targetMonth || targetMonth <= statementMonth) {
      keep.push(entry);
      continue;
    }

    if (!moves.has(targetMonth)) moves.set(targetMonth, []);
    moves.get(targetMonth).push(entry);
    const linkedId = parsePaymentIdFromNote(note);
    if (linkedId) movedPaymentIds.add(linkedId);
  }

  return { keep, moves, movedPaymentIds };
}

/**
 * Move paid/epp rows whose paid_at belongs to a later cycle month onto that
 * statement (create the month row if needed). Does not run CCP sync itself.
 *
 * @returns {Promise<{ movedToIds: string[], movedPaymentIds: Set<number> }>}
 */
async function rehomeMisplacedBreakdownEntries(stmt, cardId, statementDay) {
  const statementId = stmt && stmt.id;
  const statementMonth = stmt && stmt.statement_month;
  if (!statementId || !statementMonth || !cardId) {
    return { movedToIds: [], movedPaymentIds: new Set() };
  }

  const [paidRows, eppRows] = await Promise.all([
    CardStatementPayment.listByStatementId(statementId),
    CardStatementEpp.listByStatementId(statementId),
  ]);

  const paidPart = partitionRowsByStatementMonth(paidRows, statementMonth, statementDay);
  const eppPart = partitionRowsByStatementMonth(eppRows, statementMonth, statementDay);

  if (paidPart.moves.size === 0 && eppPart.moves.size === 0) {
    return { movedToIds: [], movedPaymentIds: new Set() };
  }

  await StatementService.updateStatement(statementId, {
    payments: paidPart.keep,
    epp_payments: eppPart.keep,
    paid_amount: sumAmounts(paidPart.keep),
    epp_balance: sumAmounts(eppPart.keep),
    _skipCreditCardPaymentSync: true,
  });

  const movedPaymentIds = new Set([
    ...paidPart.movedPaymentIds,
    ...eppPart.movedPaymentIds,
  ]);
  const movedToIds = [];
  const months = new Set([...paidPart.moves.keys(), ...eppPart.moves.keys()]);

  for (const month of months) {
    const target = await ensureStatementForCardMonth(cardId, month);
    const [tPaid, tEpp] = await Promise.all([
      CardStatementPayment.listByStatementId(target.id),
      CardStatementEpp.listByStatementId(target.id),
    ]);

    const addPaid = paidPart.moves.get(month) || [];
    const addEpp = eppPart.moves.get(month) || [];
    const updateData = { _skipCreditCardPaymentSync: true };

    if (addPaid.length > 0) {
      const existingPaid = rowsToEntries(tPaid, month, null);
      updateData.payments = [...addPaid, ...existingPaid];
      updateData.paid_amount = sumAmounts(updateData.payments);
    }
    if (addEpp.length > 0) {
      const existingEpp = rowsToEntries(tEpp, month, null);
      updateData.epp_payments = [...addEpp, ...existingEpp];
      updateData.epp_balance = sumAmounts(updateData.epp_payments);
    }

    await StatementService.updateStatement(target.id, updateData);
    movedToIds.push(target.id);
  }

  return { movedToIds, movedPaymentIds };
}

/**
 * Statement → credit_card_payments (after paid/epp breakdown change).
 * Entries linked via note `ccp:{id}` are updated; new rows create payments and rewrite notes.
 * Removed `ccp:` links delete the corresponding credit card payments.
 * Payments dated after this statement's cycle (per card statement_day) are moved
 * forward to the correct next statement month before syncing.
 *
 * @param {{ statementId: string, previousLinkedIds?: number[], cardId?: string, _skipRehome?: boolean }} opts
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

  let statementDay = 1;
  const card = await Card.getById(cardId);
  if (card && card.statement_day != null && card.statement_day !== '') {
    statementDay = card.statement_day;
  }

  let movedPaymentIds = new Set();
  let movedToIds = [];
  if (!opts._skipRehome) {
    const rehome = await rehomeMisplacedBreakdownEntries(stmt, cardId, statementDay);
    movedPaymentIds = rehome.movedPaymentIds;
    movedToIds = rehome.movedToIds;
  }

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

      // New statement paid rows get default remarks; keep any explicit note.
      // Linked payment updates above never touch remarks (user edits stay).
      let remarks = linkedId ? null : rawNote;
      if (
        paymentType === 'paid' &&
        (remarks == null || String(remarks).trim() === '')
      ) {
        remarks = DEFAULT_PAID_REMARKS;
      }

      const created = await CreditCardPayment.create({
        paymentDate: paidAt,
        creditCardId: cardId,
        customerName: stmt.card_holder || null,
        paymentMethod: 'Credit Card',
        paymentType,
        amount,
        remarks,
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

  // Sync destination months first so moved ccp: links are kept before orphan delete.
  for (const otherId of movedToIds) {
    if (!otherId || otherId === statementId) continue;
    await syncStatementBreakdownToPayments({
      statementId: otherId,
      previousLinkedIds: [],
      cardId,
      _skipRehome: true,
    });
  }

  for (const id of previousLinkedIds) {
    if (kept.has(id)) continue;
    if (movedPaymentIds.has(id)) continue;
    try {
      await CreditCardPayment.delete(id);
    } catch (err) {
      console.error('Failed to delete orphaned credit card payment after statement sync:', id, err);
    }
  }
}

/**
 * Find statement id(s) that still reference this payment via note `ccp:{id}`.
 */
async function findStatementsLinkedToPayment(paymentId, preferredCardId, preferredMonth) {
  const note = paymentLinkNote(paymentId);
  const found = [];

  if (preferredCardId && preferredMonth) {
    const stmt = await Statement.getByCardIdAndMonth(preferredCardId, preferredMonth);
    if (stmt) {
      const [paidRows, eppRows] = await Promise.all([
        CardStatementPayment.listByStatementId(stmt.id),
        CardStatementEpp.listByStatementId(stmt.id),
      ]);
      if ([...paidRows, ...eppRows].some((r) => String(r.note || '') === note)) {
        found.push({ id: stmt.id, statement_month: stmt.statement_month || preferredMonth });
      }
    }
  }

  // Fallback: payment date/card may have changed; locate by note on same card (or any card)
  if (found.length === 0) {
    const { pool } = require('../config/database');
    const params = [note, note];
    let cardFilter = '';
    if (preferredCardId) {
      cardFilter = ' AND s.credit_card_id = ?';
      params.push(preferredCardId);
    }
    const result = await pool.query(
      `SELECT DISTINCT s.id, s.statement_month
       FROM card_statements s
       WHERE s.id IN (
         SELECT statement_id FROM card_statement_payments WHERE note = ?
         UNION
         SELECT statement_id FROM card_statement_epp_payments WHERE note = ?
       )${cardFilter}`,
      params
    );
    for (const row of result.rows || []) {
      found.push({ id: row.id, statement_month: row.statement_month });
    }
  }

  return found;
}

/**
 * Remove a credit-card payment's linked paid/epp row from statement(s) (if any).
 */
async function removePaymentFromStatement(payment) {
  if (!payment || payment.id == null) return;
  const { cardId, month } = await resolveStatementMonthForPayment(payment);

  const linkedStatements = await findStatementsLinkedToPayment(payment.id, cardId, month);
  for (const stmt of linkedStatements) {
    await rewriteStatementBreakdown(stmt.id, payment.id, stmt.statement_month, null);
  }
}

/**
 * Apply (upsert) a credit-card payment onto the card statement paid or epp section.
 * Statement month follows the card's statement_day cycle, not calendar month.
 */
async function applyPaymentToStatement(payment) {
  if (!payment || payment.id == null) return;
  const { ymd, month, cardId } = await resolveStatementMonthForPayment(payment);
  if (!cardId || !month || !ymd) return;

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
  const prev = previousPayment
    ? await resolveStatementMonthForPayment(previousPayment)
    : { cardId: null, month: null };
  const next = nextPayment
    ? await resolveStatementMonthForPayment(nextPayment)
    : { cardId: null, month: null };

  const sameTarget =
    prev.cardId &&
    next.cardId &&
    prev.cardId === next.cardId &&
    prev.month &&
    next.month &&
    prev.month === next.month;

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
  statementMonthForPaymentDate,
  collectLinkedPaymentIds,
  syncStatementBreakdownToPayments,
  syncPaymentCreated,
  syncPaymentUpdated,
  syncPaymentDeleted,
  applyPaymentToStatement,
  removePaymentFromStatement,
};
