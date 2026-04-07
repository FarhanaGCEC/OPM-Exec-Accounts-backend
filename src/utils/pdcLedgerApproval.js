/**
 * Normalize PDC type labels from DB/API (trim, collapse spaces) so GCEC isn't missed.
 */
function normalizePdcType(t) {
  return String(t == null ? '' : t)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGcecPdcType(t) {
  return normalizePdcType(t).toUpperCase() === 'GCEC PDC';
}

function isCustomerPdcType(t) {
  return normalizePdcType(t).toUpperCase() === 'CUSTOMER PDC';
}

/** Interpret post_dated_cheques.daily_ledger_approved from MySQL/mysql2 (number, bool, Buffer, string, BigInt). */
function parseDailyLedgerApproved(raw) {
  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0 || raw == null) return false;
  if (typeof raw === 'bigint') return raw !== 0n;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) {
    return raw.length > 0 && raw[0] === 1;
  }
  const n = Number(String(raw).trim());
  if (!Number.isNaN(n)) return n !== 0;
  const s = String(raw).toLowerCase().trim();
  return s === '1' || s === 'true';
}

module.exports = {
  normalizePdcType,
  isGcecPdcType,
  isCustomerPdcType,
  parseDailyLedgerApproved
};
