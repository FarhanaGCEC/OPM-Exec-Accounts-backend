/**
 * Mask card numbers for API responses only.
 * Format: "5492 **** **** 5528" (first 4 + last 4; never full PAN).
 * Full numbers may remain in the DB.
 */

function maskCardNumber(cardNumber) {
  if (cardNumber == null) return null;
  const raw = String(cardNumber).trim();
  if (!raw) return null;

  // Already masked — normalize spacing
  if (/\*/.test(raw)) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 8) {
      return `${digits.slice(0, 4)} **** **** ${digits.slice(-4)}`;
    }
    if (digits.length >= 4) {
      return `**** **** **** ${digits.slice(-4)}`;
    }
    return '**** **** **** ****';
  }

  const digits = raw.replace(/\D/g, '');
  if (digits.length < 4) return '**** **** **** ****';
  if (digits.length < 8) {
    return `**** **** **** ${digits.slice(-4)}`;
  }
  return `${digits.slice(0, 4)} **** **** ${digits.slice(-4)}`;
}

/** Mask card_number / card_no / cardNumber on a plain object (shallow copy). */
function maskCardFieldsInObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = { ...obj };
  if (Object.prototype.hasOwnProperty.call(out, 'card_number')) {
    out.card_number = maskCardNumber(out.card_number);
  }
  if (Object.prototype.hasOwnProperty.call(out, 'card_no')) {
    out.card_no = maskCardNumber(out.card_no);
  }
  if (Object.prototype.hasOwnProperty.call(out, 'cardNumber')) {
    out.cardNumber = maskCardNumber(out.cardNumber);
  }
  return out;
}

function maskCardFieldsInList(list) {
  if (!Array.isArray(list)) return list;
  return list.map(maskCardFieldsInObject);
}

module.exports = {
  maskCardNumber,
  maskCardFieldsInObject,
  maskCardFieldsInList,
};
