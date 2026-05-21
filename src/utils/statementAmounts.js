function roundToCents(value) {
  return Math.round(value * 100) / 100;
}

function toAmount(value) {
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return 0;
  return parsed;
}

/**
 * Compute statement payment balances from total due, paid, and epp.
 * - total_paid = paid + epp
 * - amount_pending never drops below 0
 * - overpayment is exposed as credit_balance
 */
function calculateStatementBalances(totalPaymentDue, paid, epp = 0) {
  const totalDue = toAmount(totalPaymentDue);
  const paidAmount = toAmount(paid);
  const eppAmount = toAmount(epp);
  const totalPaid = roundToCents(paidAmount + eppAmount);

  if (totalPaid > totalDue) {
    return {
      total_paid: totalPaid,
      amount_pending: 0,
      credit_balance: roundToCents(totalPaid - totalDue),
    };
  }

  const pending = roundToCents(totalDue - totalPaid);
  return {
    total_paid: totalPaid,
    amount_pending: pending > 0 ? pending : 0,
    credit_balance: 0,
  };
}

module.exports = {
  calculateStatementBalances,
};
