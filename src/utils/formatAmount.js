// Helper function to round amount to 2 decimal places
const roundToTwoDecimals = (amount) => {
  if (amount == null || amount === '') return NaN;
  const n =
    typeof amount === 'bigint'
      ? Number(amount)
      : typeof amount === 'number' && Number.isFinite(amount)
        ? amount
        : parseFloat(String(amount));
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100) / 100;
};

/**
 * Parse amounts from UI/spreadsheets: strips AED, thousands commas, whitespace.
 * @param {unknown} raw
 * @returns {number} finite number or NaN
 */
const parseLooseAmount = (raw) => {
  if (raw == null || raw === '') return NaN;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw)
    .trim()
    .replace(/^aed\s*/i, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '');
  return parseFloat(s);
};

// Helper function to format amount to 2 decimal places (always shows .00 as string)
const formatAmount = (amount) => {
  if (amount === null || amount === undefined || amount === '') return null;
  const rounded = roundToTwoDecimals(amount);
  if (!Number.isFinite(rounded)) return null;
  return rounded.toFixed(2);
};

module.exports = {
  roundToTwoDecimals,
  formatAmount,
  parseLooseAmount
};

