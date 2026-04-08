const { roundToTwoDecimals } = require('./formatAmount');

/**
 * Normalize bill_date to YYYY-MM-DD (same rules as purchaseBills routes).
 */
function formatBillDateInput(bill_date) {
  if (bill_date === undefined || bill_date === null || bill_date === '') {
    return { ok: false, error: 'bill_date is required when provided' };
  }
  let formattedDate = bill_date;
  if (typeof bill_date === 'string') {
    if (bill_date.includes('/')) {
      const parts = bill_date.split('/');
      if (parts.length === 3) {
        const [day, month, year] = parts;
        formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
    } else if (bill_date.includes('-') && !bill_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
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
      const parts = bill_date.split('-');
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
    return { ok: false, error: 'Invalid bill_date' };
  }
  return { ok: true, value: formattedDate };
}

/**
 * Build PurchaseBill.update fields from change-request payload (snake_case body keys).
 */
function payloadToPurchaseBillUpdate(payload, { requireBillDateAndAmount = false } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const u = {};

  if (requireBillDateAndAmount) {
    if (p.bill_date === undefined || p.amount === undefined) {
      throw new Error('payload.bill_date and amount are required for this update');
    }
  }

  if (p.bill_date !== undefined) {
    const fd = formatBillDateInput(p.bill_date);
    if (!fd.ok) throw new Error(fd.error || 'Invalid bill_date');
    u.billDate = fd.value;
  }

  if (p.amount !== undefined) {
    const parsedAmount = parseFloat(p.amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new Error('Amount must be greater than 0');
    }
    u.amount = roundToTwoDecimals(parsedAmount);
  }

  if (p.invoice_number !== undefined) u.invoiceNumber = p.invoice_number || null;
  if (p.vendor_name !== undefined) u.vendorName = p.vendor_name || null;
  if (p.bill_number !== undefined) u.billNumber = p.bill_number || null;
  if (p.payment_method !== undefined) u.paymentMethod = p.payment_method || 'Credit Card';
  if (p.description !== undefined) u.description = p.description || null;
  if (p.payment_status !== undefined) {
    const validStatuses = ['Pending', 'Paid', 'Partially Paid'];
    if (!validStatuses.includes(p.payment_status)) {
      throw new Error(`payment_status must be one of: ${validStatuses.join(', ')}`);
    }
    u.paymentStatus = p.payment_status;
  }

  return u;
}

module.exports = {
  formatBillDateInput,
  payloadToPurchaseBillUpdate,
};
