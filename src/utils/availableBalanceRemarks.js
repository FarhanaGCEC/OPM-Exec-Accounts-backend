/** True when remarks identify a bank "Available Balance" ledger marker row. */
function isAvailableBalanceRemarks(remarks) {
  const normalized = (remarks == null ? '' : String(remarks)).trim().toLowerCase();
  return normalized.includes('available balance');
}

module.exports = {
  isAvailableBalanceRemarks
};
