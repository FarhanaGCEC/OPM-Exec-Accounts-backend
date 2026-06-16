const PDC = require('../models/PDC');
const { isGcecPdcType, isCustomerPdcType, parseDailyLedgerApproved } = require('./pdcLedgerApproval');
const {
  toChequeDateYmd,
  extractApprovalTimeFromBody,
  buildDailyLedgerApprovedAt,
  formatApprovalTimeForDisplay,
} = require('./pdcApprovalTime');

/**
 * After cheque_date and/or approval time change on an already-approved GCEC/Customer PDC,
 * keep daily_ledger_approved_at aligned with the new cheque date (and optional time).
 * When not yet approved, skip silently if time was sent alongside a field update.
 */
async function syncLedgerApprovedAtAfterPdcSave(existingRow, updatedRow, body = {}) {
  if (!existingRow || !updatedRow) {
    return { ok: true, pdc: updatedRow, skipped: true };
  }

  const wasApproved = parseDailyLedgerApproved(existingRow.daily_ledger_approved);
  const isCustomer = isCustomerPdcType(updatedRow.pdc_type);
  const isGcec = isGcecPdcType(updatedRow.pdc_type);

  if (!isCustomer && !isGcec) {
    return { ok: true, pdc: updatedRow, skipped: true };
  }

  const { provided: timeProvided, normalized: approvalTime } = extractApprovalTimeFromBody(body);
  if (!wasApproved) {
    if (timeProvided) {
      return { ok: true, pdc: updatedRow, skipped: true };
    }
    return { ok: true, pdc: updatedRow, skipped: true };
  }

  const oldDate = toChequeDateYmd(existingRow.cheque_date);
  const newDate = toChequeDateYmd(updatedRow.cheque_date);
  const dateChanged = oldDate !== newDate;

  if (!dateChanged && !timeProvided) {
    return { ok: true, pdc: updatedRow, skipped: true };
  }

  if (isCustomer) {
    if (timeProvided && !approvalTime) {
      return {
        ok: false,
        status: 400,
        error: 'transactionTime must be in HH:mm or HH:mm:ss format',
      };
    }
    const timeHms =
      timeProvided && approvalTime
        ? approvalTime
        : formatApprovalTimeForDisplay(updatedRow.daily_ledger_approved_at) || '09:00:00';
    const approvedAt = buildDailyLedgerApprovedAt(updatedRow.cheque_date, timeHms);
    if (!approvedAt) {
      return { ok: false, status: 400, error: 'Invalid cheque date for approval time' };
    }
    const row = await PDC.setDailyLedgerApprovedAt(updatedRow.id, approvedAt);
    if (!row) {
      return { ok: false, status: 404, error: 'Post-dated cheque not found' };
    }
    return { ok: true, pdc: row, skipped: false };
  }

  if (isGcec && dateChanged) {
    const timeHms = formatApprovalTimeForDisplay(updatedRow.daily_ledger_approved_at) || '00:00:00';
    const approvedAt = buildDailyLedgerApprovedAt(updatedRow.cheque_date, timeHms);
    if (!approvedAt) {
      return { ok: false, status: 400, error: 'Invalid cheque date for approval time' };
    }
    const row = await PDC.setDailyLedgerApprovedAt(updatedRow.id, approvedAt);
    if (!row) {
      return { ok: false, status: 404, error: 'Post-dated cheque not found' };
    }
    return { ok: true, pdc: row, skipped: false };
  }

  return { ok: true, pdc: updatedRow, skipped: true };
}

module.exports = { syncLedgerApprovedAtAfterPdcSave };
