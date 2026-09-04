const { parseLooseAmount } = require('./formatAmount');
const { isAvailableBalanceRemarks } = require('./availableBalanceRemarks');
const { normalizePdcType } = require('./pdcLedgerApproval');

const AVAILABLE_BALANCE_BG_COLOR = '#91d34d';
const LEDGER_CHEQUE_EXPORT_WIDTH = 7;

const MONTH_SHORT = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC'
];

function isGcecPdcRemarks(remarks) {
  const remarksNorm = String(remarks || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
  return (
    remarksNorm.includes('gcec pdc') ||
    remarksNorm.includes('pdc gcec') ||
    (remarksNorm.includes('gcec') && remarksNorm.includes('pdc'))
  );
}

function rowIsGcecPdcHighlight(remarks, pdcType) {
  if (isGcecPdcRemarks(remarks)) return true;
  if (pdcType && normalizePdcType(pdcType) === 'GCEC PDC') return true;
  return false;
}

function isPdcTypeLabelRemarks(remarks) {
  const norm = String(remarks ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
  if (!norm) return false;
  return (
    norm === 'customer pdc' ||
    norm === 'gcec pdc' ||
    norm === 'custom pdc' ||
    norm === 'pdc customer' ||
    norm === 'pdc gcec' ||
    norm === 'pdc custom'
  );
}

function remarksDisplayOptsForRow(row) {
  const approvedGcec =
    !!row.ledgerApproved && rowIsGcecPdcHighlight(row.remarks, row.pdcType);
  return {
    omitGcecFallback: approvedGcec,
    description: approvedGcec ? row.pdcDescription : undefined
  };
}

function remarksForDailyLedgerDisplay(remarks, pdcType, opts) {
  if (opts?.omitGcecFallback) {
    if (opts.description !== undefined) {
      if (opts.description === null) return '';
      const d = String(opts.description).trim();
      if (!d || isPdcTypeLabelRemarks(d)) return '';
      return d;
    }
    const r = String(remarks ?? '').trim();
    if (r && !isPdcTypeLabelRemarks(r)) return r;
    return '';
  }

  const r = String(remarks ?? '').trim();
  if (r) return r;
  if (rowIsGcecPdcHighlight(remarks, pdcType)) return 'GCEC PDC';
  return '';
}

function formatChequeNumberForLedgerExport(chequeNumber) {
  const raw = String(chequeNumber ?? '')
    .replace(/,/g, '')
    .trim();
  if (!raw || raw === '-') return '';
  if (/^0\d*$/.test(raw)) {
    return raw.length >= LEDGER_CHEQUE_EXPORT_WIDTH
      ? raw
      : raw.padStart(LEDGER_CHEQUE_EXPORT_WIDTH, '0');
  }
  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw;
  return digits.padStart(LEDGER_CHEQUE_EXPORT_WIDTH, '0');
}

function toTitleCaseWords(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function ledgerExportDetailsColumn(row) {
  const paymentType = String(row.paymentType || row.payment_type || '').trim();
  const normalized = paymentType.toLowerCase();
  const chequeNumber = row.chequeNumber ?? row.cheque_number ?? '';

  if (normalized === 'cheque') {
    if (chequeNumber && chequeNumber !== '-') {
      const formatted = formatChequeNumberForLedgerExport(chequeNumber);
      if (formatted) return formatted;
    }
    return 'Cheque';
  }
  if (normalized === 'cash') return 'Cash';
  if (normalized === 'creditcard') return 'Credit Card';
  if (normalized === 'banktransfer' || normalized === 'online') return 'Online';
  if (normalized === 'dd') return 'DD';
  if (paymentType) return toTitleCaseWords(paymentType);
  return '';
}

function descriptionDisplayForRow(row) {
  if (row.syntheticFromPdc) {
    return row.customerName || row.category || '-';
  }
  return row.category || '-';
}

function parseRowDate(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const d = new Date(`${raw.slice(0, 10)}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const slashParts = raw.split('/');
  if (slashParts.length === 3) {
    const d = new Date(
      Number(slashParts[2]),
      Number(slashParts[1]) - 1,
      Number(slashParts[0])
    );
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const mmm = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  if (mmm) {
    const monthIndex = MONTH_SHORT.findIndex(
      (m) => m.toLowerCase() === mmm[2].toLowerCase()
    );
    if (monthIndex >= 0) {
      const year =
        mmm[3].length === 2 ? 2000 + Number(mmm[3]) : Number(mmm[3]);
      const d = new Date(year, monthIndex, Number(mmm[1]));
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }

  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function datePartsForRow(row) {
  const parsed = parseRowDate(row.date);
  if (!parsed) {
    return { dateDay: '--', dateMonth: '---', dateYear: '--' };
  }
  return {
    dateDay: String(parsed.getDate()).padStart(2, '0'),
    dateMonth: MONTH_SHORT[parsed.getMonth()],
    dateYear: String(parsed.getFullYear()).slice(-2)
  };
}

function formatAedDisplay(amount) {
  const n = parseLooseAmount(amount);
  const value = Number.isFinite(n) ? n : 0;
  return `AED ${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function amountDisplayForField(rawValue) {
  if (rawValue == null || rawValue === '') {
    return 'AED 0.00';
  }
  return formatAedDisplay(rawValue);
}

/**
 * Adds mobile/card display fields to an AED ledger row without changing raw fields.
 * Mirrors web BankTransaction ledgerExportDetailsColumn + remarksForDailyLedgerDisplay.
 */
function enrichAedTransactionRowForDisplay(row) {
  const remarksDisplay = remarksForDailyLedgerDisplay(
    row.remarks,
    row.pdcType,
    remarksDisplayOptsForRow(row)
  );
  const isAvailableBalanceRow = isAvailableBalanceRemarks(row.remarks);
  const dateParts = datePartsForRow(row);

  return {
    ...row,
    descriptionDisplay: descriptionDisplayForRow(row),
    detailsDisplay: ledgerExportDetailsColumn(row),
    remarksDisplay,
    isAvailableBalanceRow,
    balanceCellBgColor: isAvailableBalanceRow ? AVAILABLE_BALANCE_BG_COLOR : null,
    debitDisplay: amountDisplayForField(row.debit),
    creditDisplay: amountDisplayForField(row.credit),
    balanceDisplay: amountDisplayForField(row.balance),
    ...dateParts
  };
}

module.exports = {
  enrichAedTransactionRowForDisplay,
  remarksForDailyLedgerDisplay,
  ledgerExportDetailsColumn,
  rowIsGcecPdcHighlight,
  formatAedDisplay
};
