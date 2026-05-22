/**
 * Customer PDC daily-ledger approval time (sort/display in Daily Transactions).
 * Times are stored on cheque_date + HH:mm:ss in DB session timezone (+04:00 default).
 */

function toChequeDateYmd(chequeDate) {
  if (chequeDate == null) return '';
  if (chequeDate instanceof Date) {
    const y = chequeDate.getFullYear();
    const m = String(chequeDate.getMonth() + 1).padStart(2, '0');
    const day = String(chequeDate.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const s = String(chequeDate).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (s.includes('/')) {
    const [day, month, year] = s.split('/');
    if (year && month && day) return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return s;
}

/** HH:mm or HH:mm:ss → HH:mm:ss, or null if input absent. Throws-style via null return on invalid when input present. */
function normalizeApprovalTimeInput(time) {
  if (time == null || String(time).trim() === '') return null;
  const raw = String(time).trim();
  const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) return null;
  const hh = match[1].padStart(2, '0');
  const mm = match[2];
  const ss = match[3] || '00';
  return `${hh}:${mm}:${ss}`;
}

function extractApprovalTimeFromBody(body = {}) {
  const raw =
    body.transactionTime ??
    body.transaction_time ??
    body.time ??
    body.approvalTime ??
    body.approval_time ??
    null;
  if (raw == null || String(raw).trim() === '') return { provided: false, normalized: null };
  const normalized = normalizeApprovalTimeInput(raw);
  return { provided: true, normalized };
}

function buildDailyLedgerApprovedAt(chequeDate, timeHms) {
  const ymd = toChequeDateYmd(chequeDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  if (!timeHms) return null;
  return `${ymd} ${timeHms}`;
}

function formatApprovalTimeForDisplay(approvedAt) {
  if (!approvedAt) return null;
  const d = approvedAt instanceof Date ? approvedAt : new Date(approvedAt);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

module.exports = {
  toChequeDateYmd,
  normalizeApprovalTimeInput,
  extractApprovalTimeFromBody,
  buildDailyLedgerApprovedAt,
  formatApprovalTimeForDisplay
};
