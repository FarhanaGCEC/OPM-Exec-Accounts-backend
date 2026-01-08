const express = require('express');
const { pool } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { formatAmount, roundToTwoDecimals } = require('../utils/formatAmount');

const router = express.Router();

// Get account summary
router.get('/', authenticateToken, async (req, res) => {
  try {
    // Get total balance (latest transaction balance)
    const balanceResult = await pool.query(
      'SELECT balance FROM transactions ORDER BY id DESC LIMIT 1'
    );
    const totalBalance = balanceResult.rows.length > 0 
      ? formatAmount(balanceResult.rows[0].balance) 
      : "0.00";

    // Get total credit (sum of all credit transactions)
    const creditResult = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'Credit'"
    );
    const totalCredit = formatAmount(creditResult.rows[0].total);

    // Get total debit (sum of all debit transactions)
    const debitResult = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'Debit'"
    );
    const totalDebit = formatAmount(debitResult.rows[0].total);

    // Get pending checks count and total amount (all PDCs)
    const pendingChecksResult = await pool.query(
      `SELECT 
        COUNT(*) as count,
        COALESCE(SUM(amount), 0) as total_amount
      FROM post_dated_cheques`
    );

    const pendingChecksCount = parseInt(pendingChecksResult.rows[0].count);
    const totalPendingCheckAmount = formatAmount(pendingChecksResult.rows[0].total_amount);

    res.json({
      success: true,
      data: {
        totalBalance: totalBalance,
        totalCredit: totalCredit,
        totalDebit: totalDebit,
        pendingChecks: {
          count: pendingChecksCount,
          totalAmount: totalPendingCheckAmount
        }
      }
    });
  } catch (error) {
    console.error('Error fetching account summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch account summary'
    });
  }
});

module.exports = router;

