const { roundToTwoDecimals } = require('./formatAmount');

const VALID_PAYMENT_TYPES = ['paid', 'epp'];

/**
 * Normalize payment_type to paid|epp. Returns null when input is empty/absent.
 */
function normalizePaymentType(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null;
  }
  const value = String(raw).trim().toLowerCase();
  if (!VALID_PAYMENT_TYPES.includes(value)) {
    throw new Error(`payment_type must be one of: ${VALID_PAYMENT_TYPES.join(', ')}`);
  }
  return value;
}

/**
 * Normalize payment_date to YYYY-MM-DD (same rules as creditCardPayments routes).
 */
function formatPaymentDateInput(payment_date) {
  if (payment_date === undefined || payment_date === null || payment_date === '') {
    return { ok: false, error: 'payment_date is required when provided' };
  }
  let formattedDate = payment_date;
  if (typeof payment_date === 'string') {
    if (payment_date.includes('/')) {
      const parts = payment_date.split('/');
      if (parts.length === 3) {
        const [day, month, year] = parts;
        formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
    } else if (payment_date.includes('-') && !payment_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      const months = {
        Jan: '01',
        Feb: '02',
        Mar: '03',
        Apr: '04',
        May: '05',
        Jun: '06',
        Jul: '07',
        Aug: '08',
        Sep: '09',
        Oct: '10',
        Nov: '11',
        Dec: '12',
      };
      const parts = payment_date.split('-');
      if (parts.length === 3) {
        const day = parts[0].padStart(2, '0');
        const month = months[parts[1]] || parts[1].padStart(2, '0');
        let year = parts[2];
        if (year.length === 2) {
          year = `20${year}`;
        }
        formattedDate = `${year}-${month}-${day}`;
      }
    }
  }
  const dateObj = new Date(formattedDate);
  if (isNaN(dateObj.getTime())) {
    return { ok: false, error: 'Invalid payment_date' };
  }
  return { ok: true, value: formattedDate };
}

/**
 * Build CreditCardPayment.update fields from change-request payload (snake_case body keys).
 */
function payloadToCreditCardPaymentUpdate(payload, { requirePaymentDateAndAmount = false } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const u = {};

  if (requirePaymentDateAndAmount) {
    if (p.payment_date === undefined || p.amount === undefined) {
      throw new Error('payload.payment_date and amount are required for this update');
    }
  }

  if (p.payment_date !== undefined) {
    const fd = formatPaymentDateInput(p.payment_date);
    if (!fd.ok) throw new Error(fd.error || 'Invalid payment_date');
    u.paymentDate = fd.value;
  }

  if (p.amount !== undefined) {
    const parsedAmount = parseFloat(p.amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new Error('Amount must be greater than 0');
    }
    u.amount = roundToTwoDecimals(parsedAmount);
  }

  if (p.credit_card_id !== undefined) u.creditCardId = p.credit_card_id || null;
  if (p.card_holder !== undefined) u.customerName = p.card_holder || null;
  if (p.card_no !== undefined) {
    // card_no is display-only on API; credit_card_id is the persisted link
  }
  if (p.remarks !== undefined) u.remarks = p.remarks || null;
  if (p.paid_against !== undefined) u.paidAgainst = p.paid_against || null;
  if (p.paidAgainst !== undefined) u.paidAgainst = p.paidAgainst || null;
  if (p.payment_type !== undefined || p.paymentType !== undefined) {
    const normalized = normalizePaymentType(p.payment_type ?? p.paymentType);
    u.paymentType = normalized || 'paid';
  }

  return u;
}

module.exports = {
  VALID_PAYMENT_TYPES,
  normalizePaymentType,
  formatPaymentDateInput,
  payloadToCreditCardPaymentUpdate,
};
