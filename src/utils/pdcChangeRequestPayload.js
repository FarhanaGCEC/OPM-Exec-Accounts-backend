const { roundToTwoDecimals } = require('./formatAmount');
const { normalizePdcDescriptionInput } = require('./pdcDescription');

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function normalizePdcInput(body = {}) {
  const customerName =
    body.customerName ??
    body.customer_name ??
    body.customer ??
    body.payee ??
    body.payeeName ??
    body.payee_name ??
    body.partyName ??
    body.party_name;
  return {
    chequeDate: body.chequeDate ?? body.cheque_date,
    chequeNumber: body.chequeNumber ?? body.cheque_number,
    customerName,
    amount: body.amount,
    chequeType: body.chequeType ?? body.cheque_type,
    pdcType: body.pdcType ?? body.pdc_type,
    description: body.description ?? body.description_text,
  };
}

function isMissingPdcRequired(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return false;
}

function collectMissingPdcFields({ chequeDate, chequeNumber, customerName, amount, chequeType, pdcType }) {
  const missing = [];
  if (isMissingPdcRequired(chequeDate)) missing.push('chequeDate');
  if (isMissingPdcRequired(chequeNumber)) missing.push('chequeNumber');
  if (isMissingPdcRequired(customerName)) missing.push('customerName');
  if (amount === undefined || amount === null || amount === '') missing.push('amount');
  if (isMissingPdcRequired(chequeType)) missing.push('chequeType');
  if (isMissingPdcRequired(pdcType)) missing.push('pdcType');
  return missing;
}

/**
 * Same validation as elevated PDC PUT/PATCH (no image). Returns camelCase fields for PDC.update.
 */
function validateAndBuildPdcUpdate(body) {
  const o = normalizePdcInput(body || {});
  const missing = collectMissingPdcFields({
    chequeDate: o.chequeDate,
    chequeNumber: o.chequeNumber,
    customerName: o.customerName,
    amount: o.amount,
    chequeType: o.chequeType,
    pdcType: o.pdcType,
  });
  if (missing.length > 0) {
    return {
      ok: false,
      error: 'cheque_date, cheque_number, customer_name, amount, cheque_type, and pdc_type are required',
      missingFields: missing,
    };
  }

  const validChequeTypes = ['Payment Cheque', 'Security Cheque', 'Other'];
  if (!validChequeTypes.includes(o.chequeType)) {
    return { ok: false, error: `cheque_type must be one of: ${validChequeTypes.join(', ')}` };
  }

  const validPDCTypes = ['GCEC PDC', 'Customer PDC', 'Custom PDC'];
  if (!validPDCTypes.includes(o.pdcType)) {
    return { ok: false, error: `pdc_type must be one of: ${validPDCTypes.join(', ')}` };
  }

  if (o.pdcType === 'Custom PDC' && (!o.description || String(o.description).trim() === '')) {
    return { ok: false, error: 'Description is required for Custom PDC' };
  }

  const parsedAmount = parseFloat(o.amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return { ok: false, error: 'Amount must be greater than 0' };
  }

  const dateStr = String(o.chequeDate);
  let formattedDate = dateStr;
  if (dateStr.includes('/')) {
    const [day, month, year] = dateStr.split('/');
    formattedDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  return {
    ok: true,
    value: {
      chequeDate: formattedDate,
      chequeNumber: String(o.chequeNumber).trim(),
      customerName: String(o.customerName).trim(),
      amount: roundToTwoDecimals(parsedAmount),
      chequeType: o.chequeType,
      pdcType: o.pdcType,
      description: o.description ? String(o.description).trim() : null,
    },
  };
}

const PDC_BODY_FIELD_KEYS = [
  'chequeDate',
  'cheque_date',
  'chequeNumber',
  'cheque_number',
  'customerName',
  'customer_name',
  'customer',
  'payee',
  'payeeName',
  'payee_name',
  'partyName',
  'party_name',
  'amount',
  'chequeType',
  'cheque_type',
  'pdcType',
  'pdc_type',
  'description',
  'description_text',
  'remarks'
];

function bodyHasPdcFieldUpdates(body) {
  const b = body || {};
  return PDC_BODY_FIELD_KEYS.some((k) => Object.prototype.hasOwnProperty.call(b, k));
}

/** Fill missing PATCH fields from the existing DB row (supports attachment-only edits). */
function mergePdcUpdateWithExisting(body, existing) {
  const b = body || {};
  const n = normalizePdcInput(b);
  const descInBody = hasOwn(b, 'description') || hasOwn(b, 'description_text') || hasOwn(b, 'remarks');
  const pdcType = n.pdcType ?? existing.pdc_type;
  let description = existing.description;
  if (descInBody) {
    const rawDesc = hasOwn(b, 'remarks') && !hasOwn(b, 'description') && !hasOwn(b, 'description_text')
      ? b.remarks
      : n.description;
    description = normalizePdcDescriptionInput(rawDesc, pdcType);
  }
  return {
    chequeDate: n.chequeDate ?? existing.cheque_date,
    chequeNumber: n.chequeNumber ?? existing.cheque_number,
    customerName: n.customerName ?? existing.customer_name,
    amount: n.amount != null && n.amount !== '' ? n.amount : existing.amount,
    chequeType: n.chequeType ?? existing.cheque_type,
    pdcType,
    description
  };
}

module.exports = {
  normalizePdcInput,
  validateAndBuildPdcUpdate,
  bodyHasPdcFieldUpdates,
  mergePdcUpdateWithExisting,
  collectMissingPdcFields,
  isMissingPdcRequired
};
