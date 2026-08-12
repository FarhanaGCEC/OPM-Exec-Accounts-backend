const { roundToTwoDecimals } = require('./formatAmount');

const LEGACY_HEADER_NOTE = 'legacy:header';
/** Match DB session timezone default (+04:00 UAE). */
const BUSINESS_TZ_OFFSET_MINUTES = 4 * 60;

function isLegacyHeaderNote(note) {
  return String(note || '').trim().toLowerCase() === LEGACY_HEADER_NOTE;
}

function firstOfStatementMonth(statementMonth) {
  if (!statementMonth || !/^\d{4}-\d{2}$/.test(statementMonth)) return null;
  return `${statementMonth}-01`;
}

/**
 * Normalize paid_at to YYYY-MM-DD in business timezone (+04:00).
 * MySQL DATE values often arrive as UTC Date objects (e.g. 2026-05-31T20:00:00Z → 2026-06-01).
 */
function normalizePaidAtYmd(paidAt) {
  if (paidAt == null || paidAt === '') return null;

  if (typeof paidAt === 'string') {
    const trimmed = paidAt.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  }

  const d = paidAt instanceof Date ? paidAt : new Date(paidAt);
  if (Number.isNaN(d.getTime())) {
    const m = String(paidAt).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }

  const businessMs = d.getTime() + BUSINESS_TZ_OFFSET_MINUTES * 60 * 1000;
  const bd = new Date(businessMs);
  const y = bd.getUTCFullYear();
  const mo = String(bd.getUTCMonth() + 1).padStart(2, '0');
  const day = String(bd.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

function isFirstOfStatementMonth(paidAt, statementMonth) {
  const ymd = normalizePaidAtYmd(paidAt);
  const first = firstOfStatementMonth(statementMonth);
  return ymd != null && first != null && ymd === first;
}

function isHeaderTotalDuplicate(entry, others) {
  if (!others.length) return false;
  if (isLegacyHeaderNote(entry.note)) return true;

  const amount = roundToTwoDecimals(entry.amount);
  if (!Number.isFinite(amount)) return false;

  const otherSum = roundToTwoDecimals(
    others.reduce((acc, e) => acc + (Number(e.amount) || 0), 0)
  );
  if (!Number.isFinite(otherSum) || Math.abs(amount - otherSum) > 0.009) {
    return false;
  }

  const note = entry.note != null ? String(entry.note).trim() : '';
  if (note.startsWith('ccp:')) return false;

  return true;
}

/**
 * Remove duplicate / legacy breakdown rows before save or API response.
 * - Drops legacy:header rows when real payment rows exist
 * - Drops 1st-of-month header totals that equal the sum of the other rows
 * - Drops 1st-of-month rows that duplicate the same amount on another date
 */
function sanitizeBreakdownEntries(entries, statementMonth) {
  let list = (Array.isArray(entries) ? entries : []).map((e) => ({ ...e }));

  const nonLegacy = list.filter((e) => !isLegacyHeaderNote(e.note));
  if (nonLegacy.length > 0 && nonLegacy.length < list.length) {
    list = nonLegacy;
  }

  if (list.length > 1 && statementMonth) {
    list = list.filter((entry, idx) => {
      const others = list.filter((_, i) => i !== idx);
      if (!isFirstOfStatementMonth(entry.paid_at, statementMonth)) return true;
      return !isHeaderTotalDuplicate(entry, others);
    });
  }

  const firstOfMonth = firstOfStatementMonth(statementMonth);
  if (firstOfMonth) {
    const amountsOnOtherDates = new Set(
      list
        .filter((e) => normalizePaidAtYmd(e.paid_at) !== firstOfMonth)
        .map((e) => roundToTwoDecimals(e.amount))
        .filter((n) => Number.isFinite(n))
    );
    list = list.filter((e) => {
      const paidAt = normalizePaidAtYmd(e.paid_at);
      if (paidAt !== firstOfMonth) return true;
      const amt = roundToTwoDecimals(e.amount);
      return !amountsOnOtherDates.has(amt);
    });
  }

  return list;
}

function sumBreakdownAmounts(entries) {
  return roundToTwoDecimals(
    (entries || []).reduce((acc, e) => acc + (Number(e.amount) || 0), 0)
  );
}

module.exports = {
  LEGACY_HEADER_NOTE,
  isLegacyHeaderNote,
  normalizePaidAtYmd,
  sanitizeBreakdownEntries,
  sumBreakdownAmounts,
};
