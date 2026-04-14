/**
 * Normalize frontend payload for transaction edits (camelCase or snake_case).
 * Matches behaviour expected by Transaction.update (payment_type lowercased, YYYY-MM-DD date).
 */
function normalizeTransactionEditPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const dateRaw = p.date;
  const type = p.type;
  const amount = p.amount;
  const paymentTypeRaw = p.paymentType ?? p.payment_type;
  const categoryIdRaw = p.categoryId ?? p.category_id;
  const chequeNumber = p.chequeNumber ?? p.cheque_number ?? null;
  const remarks = p.remarks ?? null;

  let formattedDate = dateRaw;
  if (typeof dateRaw === 'string' && dateRaw.includes('/')) {
    const [day, month, year] = dateRaw.split('/');
    formattedDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const paymentType =
    paymentTypeRaw != null && paymentTypeRaw !== ''
      ? String(paymentTypeRaw).toLowerCase()
      : null;

  let categoryId = null;
  if (categoryIdRaw !== undefined && categoryIdRaw !== null && categoryIdRaw !== '') {
    const n = parseInt(categoryIdRaw, 10);
    categoryId = Number.isInteger(n) && n > 0 ? n : null;
  }

  return {
    date: formattedDate,
    type,
    amount,
    paymentType,
    categoryId,
    chequeNumber,
    remarks,
  };
}

function assertTransactionEditRequired(normalized) {
  const required = ['date', 'type', 'amount', 'paymentType'];
  for (const k of required) {
    if (normalized[k] === undefined || normalized[k] === null || normalized[k] === '') {
      throw new Error(`payload.${k === 'paymentType' ? 'paymentType (or payment_type)' : k} is required for edit`);
    }
  }
  if (normalized.type !== 'Debit' && normalized.type !== 'Credit') {
    throw new Error('type must be Debit or Credit');
  }
  const validPaymentTypes = ['cash', 'cheque', 'creditcard', 'online', 'dd'];
  if (!validPaymentTypes.includes(String(normalized.paymentType).toLowerCase())) {
    throw new Error(`paymentType must be one of: ${validPaymentTypes.join(', ')}`);
  }
  if (String(normalized.paymentType).toLowerCase() === 'cheque' && !normalized.chequeNumber) {
    throw new Error('cheque_number (or chequeNumber) is required when payment type is cheque');
  }
  const amt = parseFloat(normalized.amount);
  if (isNaN(amt) || amt <= 0) {
    throw new Error('amount must be a number > 0');
  }
}

module.exports = {
  normalizeTransactionEditPayload,
  assertTransactionEditRequired,
};
