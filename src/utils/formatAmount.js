// Helper function to round amount to 2 decimal places
const roundToTwoDecimals = (amount) => {
  return Math.round(parseFloat(amount) * 100) / 100;
};

// Helper function to format amount to 2 decimal places (always shows .00 as string)
const formatAmount = (amount) => {
  if (amount === null || amount === undefined || amount === '') return null;
  // Convert to number if it's a string
  const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(numAmount)) return null;
  return roundToTwoDecimals(numAmount).toFixed(2);
};

module.exports = {
  roundToTwoDecimals,
  formatAmount
};

