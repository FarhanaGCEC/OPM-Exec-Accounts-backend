const express = require('express');
const { pool } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const { formatAmount, roundToTwoDecimals } = require('../utils/formatAmount');
const {
  isCustomerPdcType,
  isGcecPdcType,
  parseDailyLedgerApproved,
  shouldPdcAffectBalance
} = require('../utils/pdcLedgerApproval');

const router = express.Router();

function toYmd(d) {
  if (d == null) return '';
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const s = String(d);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

function sortMergedByDateThenId(rows) {
  return [...rows].sort((a, b) => {
    const da = toYmd(a.date);
    const db = toYmd(b.date);
    if (da !== db) return da.localeCompare(db);
    const ida = typeof a.id === 'number' ? a.id : Number.MAX_SAFE_INTEGER;
    const idb = typeof b.id === 'number' ? b.id : Number.MAX_SAFE_INTEGER;
    if (ida !== idb) return ida - idb;
    return String(a.id).localeCompare(String(b.id));
  });
}

// Get account summary
router.get('/', authenticateToken, async (req, res) => {
  try {
    const asOfDate = req.query.asOfDate || new Date().toISOString().split('T')[0];

    // Basic YYYY-MM-DD guard to avoid malformed input in SQL filters
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid asOfDate format. Use YYYY-MM-DD'
      });
    }

    // Get base total balance as of selected date (fallback in case merged rows are empty)
    const balanceResult = await pool.query(
      `SELECT balance
       FROM transactions
       WHERE date <= ?
       ORDER BY date DESC, id DESC
       LIMIT 1`,
      [asOfDate]
    );
    const baseTotalBalance = balanceResult.rows.length > 0
      ? formatAmount(balanceResult.rows[0].balance)
      : "0.00";

    // Get total credit up to selected date
    const creditResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE type = 'Credit' AND date <= ?`,
      [asOfDate]
    );
    const totalCredit = formatAmount(creditResult.rows[0].total);

    // Get total debit up to selected date
    const debitResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE type = 'Debit' AND date <= ?`,
      [asOfDate]
    );
    const totalDebit = formatAmount(debitResult.rows[0].total);

    // Get pending checks after selected date (future PDCs)
    const pendingChecksResult = await pool.query(
      `SELECT 
        COUNT(*) as count,
        COALESCE(SUM(amount), 0) as total_amount
      FROM post_dated_cheques
      WHERE cheque_date > ?`,
      [asOfDate]
    );

    const pendingChecksCount = parseInt(pendingChecksResult.rows[0].count);
    const totalPendingCheckAmount = formatAmount(pendingChecksResult.rows[0].total_amount);
    
    // Match /api/transactions running-balance source (transactions + matured/today PDC)
    const allTransactions = await Transaction.getAll();

    const dailyRows = allTransactions.map((txn) => ({
      id: txn.id,
      date: txn.date,
      debit: txn.type === 'Debit' ? formatAmount(txn.amount) : null,
      credit: txn.type === 'Credit' ? formatAmount(txn.amount) : null,
      remarks: txn.remarks || null
    }));

    const pdcRowsResult = await pool.query(
      `
      SELECT
        pdc.id,
        DATE_FORMAT(pdc.cheque_date, '%Y-%m-%d') AS cheque_date_ymd,
        pdc.amount,
        pdc.pdc_type,
        COALESCE(pdc.daily_ledger_approved, 0) AS daily_ledger_approved
      FROM post_dated_cheques pdc
      WHERE (
        (pdc.cheque_date <= CURDATE() AND pdc.pdc_type IN ('GCEC PDC', 'Customer PDC', 'Custom PDC'))
        OR
        (
          pdc.pdc_type = 'GCEC PDC'
          AND pdc.cheque_date > CURDATE()
          AND pdc.cheque_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
        )
      )
      ORDER BY pdc.cheque_date ASC, pdc.created_at ASC, pdc.id ASC
      `
    );
    const todayYmd = toYmd(new Date());
    const maturedOrTodayPdcRows = pdcRowsResult.rows
      .map((pdc) => {
        const rowDate = pdc.cheque_date_ymd || toYmd(pdc.cheque_date);
        const isCustomerPdc = isCustomerPdcType(pdc.pdc_type);
        const isGcecPdc = isGcecPdcType(pdc.pdc_type);
        const ledgerApproved = parseDailyLedgerApproved(pdc.daily_ledger_approved);
        const shouldAffectBalance = isCustomerPdc
          ? true
          : shouldPdcAffectBalance(pdc.pdc_type, pdc.daily_ledger_approved);
        const todayYmd = toYmd(new Date());
        // GCEC PDC: before cheque date show as credit; on/after cheque date show as debit.
        // Customer PDC: debit until approved, then credit.
        const isCredit = (isGcecPdc && rowDate > todayYmd) || (isCustomerPdc && ledgerApproved);
        return {
          id: `pdc-due-${pdc.id}`,
          date: rowDate,
          debit: isCredit ? null : formatAmount(pdc.amount),
          credit: isCredit ? formatAmount(pdc.amount) : null,
          affectsBalance: shouldAffectBalance,
          remarks: pdc.pdc_type || null
        };
      })
      .filter((row) => toYmd(row.date) <= todayYmd);

    const rowsForRunningBalance = sortMergedByDateThenId([...dailyRows, ...maturedOrTodayPdcRows]);
    if (rowsForRunningBalance.length > 0) {
      const firstYmd = toYmd(rowsForRunningBalance[0].date);
      let runningBalance = await Transaction.getBalanceBeforeDate(firstYmd);
      for (const row of rowsForRunningBalance) {
        if (row.affectsBalance === false) {
          row.balance = formatAmount(runningBalance);
          continue;
        }
        const debitAmt = row.debit != null ? Number(row.debit) : 0;
        const creditAmt = row.credit != null ? Number(row.credit) : 0;
        if (!Number.isNaN(debitAmt) && debitAmt > 0) {
          runningBalance = roundToTwoDecimals(runningBalance - debitAmt);
        }
        if (!Number.isNaN(creditAmt) && creditAmt > 0) {
          runningBalance = roundToTwoDecimals(runningBalance + creditAmt);
        }
        row.balance = formatAmount(runningBalance);
      }
    }

    const latestBalanceAsOfDateRows = rowsForRunningBalance.filter((row) => {
      const txnDate = toYmd(row.date);
      return txnDate <= asOfDate;
    });
    const totalBalance =
      latestBalanceAsOfDateRows.length > 0
        ? formatAmount(latestBalanceAsOfDateRows[latestBalanceAsOfDateRows.length - 1].balance)
        : baseTotalBalance;

    const availableBalanceRows = rowsForRunningBalance.filter((row) => {
      const remarks = String(row.remarks || '').trim().toLowerCase();
      const txnDate = toYmd(row.date);
      return remarks === 'available balance' && txnDate <= asOfDate;
    });
    const latestAvailableBalance =
      availableBalanceRows.length > 0 ? availableBalanceRows[availableBalanceRows.length - 1].balance : null;
    const mainAvailableBalance =
      latestAvailableBalance != null ? formatAmount(latestAvailableBalance) : "0.00";
    const availableBalance = mainAvailableBalance;

    res.json({
      success: true,
      data: {
        asOfDate,
        totalBalance: totalBalance,
        mainAvailableBalance,
        availableBalance,
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

