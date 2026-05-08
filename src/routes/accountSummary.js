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

function formatTimeForDisplay(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function getOrderTimestampMs(row) {
  if (!row) return 0;
  // Approved Customer PDC rows already carry transactionTime equal to the
  // time-of-day portion of daily_ledger_approved_at. Combining row.date with
  // that time gives the correct intra-day sort key without UTC drift that
  // would otherwise push the row onto a different calendar day.
  if (row.transactionTime) {
    const datePart = toYmd(row.date) || toYmd(new Date());
    const candidate = new Date(`${datePart}T${String(row.transactionTime)}`);
    const msFromTime = candidate.getTime();
    if (Number.isFinite(msFromTime)) return msFromTime;
  }
  return 0;
}

function sortMergedByDateThenId(rows) {
  return [...rows].sort((a, b) => {
    const da = toYmd(a.date);
    const db = toYmd(b.date);
    if (da !== db) return da.localeCompare(db);
    const aOrderMs = getOrderTimestampMs(a);
    const bOrderMs = getOrderTimestampMs(b);
    if (aOrderMs !== bOrderMs) return aOrderMs - bOrderMs;
    const ida = numericSortIdValue(a);
    const idb = numericSortIdValue(b);
    if (ida !== idb) return ida - idb;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  });
}

function numericSortIdValue(row) {
  if (!row) return Number.MAX_SAFE_INTEGER;
  if (typeof row.id === 'number' && Number.isFinite(row.id)) return row.id;
  if (row.pdcId != null) {
    const n = Number(row.pdcId);
    if (Number.isFinite(n)) return n;
  }
  if (typeof row.id === 'string') {
    const m = /^pdc-due-(\d+)$/i.exec(row.id);
    if (m) return parseInt(m[1], 10);
    const n = parseInt(row.id, 10);
    if (Number.isFinite(n)) return n;
  }
  return Number.MAX_SAFE_INTEGER;
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
      transactionTime: txn.transaction_time || '00:00:00',
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
        COALESCE(pdc.daily_ledger_approved, 0) AS daily_ledger_approved,
        pdc.daily_ledger_approved_at
      FROM post_dated_cheques pdc
      WHERE (
        (pdc.cheque_date <= CURDATE() AND pdc.pdc_type IN ('GCEC PDC', 'Customer PDC', 'Custom PDC'))
        OR
        (
          pdc.pdc_type = 'GCEC PDC'
          AND pdc.cheque_date > CURDATE()
          AND pdc.cheque_date <= DATE_ADD(CURDATE(), INTERVAL 15 DAY)
        )
      )
      AND UPPER(TRIM(COALESCE(pdc.cheque_type, ''))) <> 'SECURITY CHEQUE'
      ORDER BY pdc.cheque_date ASC, pdc.created_at ASC, pdc.id ASC
      `
    );
    const todayYmd = toYmd(new Date());
    const maturedOrTodayPdcRows = pdcRowsResult.rows
      .map((pdc) => {
        const rowDate = pdc.cheque_date_ymd || toYmd(pdc.cheque_date);
        const isCustomerPdc = isCustomerPdcType(pdc.pdc_type);
        const ledgerApproved = parseDailyLedgerApproved(pdc.daily_ledger_approved);
        const shouldAffectBalance = isCustomerPdc
          ? true
          : shouldPdcAffectBalance(pdc.pdc_type, pdc.daily_ledger_approved);
        const todayYmd = toYmd(new Date());
        // GCEC PDC: always debit in ledger display (including upcoming). Customer PDC: always credit.
        const isCredit = isCustomerPdc;
        return {
          id: `pdc-due-${pdc.id}`,
          date: rowDate,
          transactionTime:
            isCustomerPdc && ledgerApproved
              ? formatTimeForDisplay(pdc.daily_ledger_approved_at) || '09:00:00'
              : isCustomerPdc
                ? '09:00:00'
                : '00:00:00',
          debit: isCredit ? null : formatAmount(pdc.amount),
          credit: isCredit ? formatAmount(pdc.amount) : null,
          affectsBalance: shouldAffectBalance,
          remarks: pdc.pdc_type || null,
          pdcType: pdc.pdc_type,
          dailyLedgerApproved: ledgerApproved,
          dailyLedgerApprovedAt: pdc.daily_ledger_approved_at || null
        };
      })
      // Keep matured rows for every day, plus upcoming GCEC PDC (already capped to +15 days by SQL)
      // so its forecasted debit shows up in the running balance.
      .filter((row) => toYmd(row.date) <= todayYmd || isGcecPdcType(row.pdcType));

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
    const totalsAsOfDateRows = rowsForRunningBalance.filter((row) => {
      const txnDate = toYmd(row.date);
      return txnDate <= asOfDate && row.affectsBalance !== false;
    });
    let totalCreditAmount = 0;
    let totalDebitAmount = 0;
    for (const row of totalsAsOfDateRows) {
      const debitAmt = row.debit != null ? Number(row.debit) : 0;
      const creditAmt = row.credit != null ? Number(row.credit) : 0;
      if (!Number.isNaN(debitAmt) && debitAmt > 0) totalDebitAmount += debitAmt;
      if (!Number.isNaN(creditAmt) && creditAmt > 0) totalCreditAmount += creditAmt;
    }
    const totalCredit = formatAmount(totalCreditAmount);
    const totalDebit = formatAmount(totalDebitAmount);

    // Available Balance is explicitly the recomputed balance of the most recent
    // ledger row (on or before asOfDate) whose remarks read "Available Balance".
    // We use the running-balance value so the figure stays consistent with the
    // current effects of approved Customer PDCs and matured/upcoming GCEC PDCs.
    const availableBalanceRows = rowsForRunningBalance.filter((row) => {
      if (!row || !row.remarks) return false;
      const txnDate = toYmd(row.date);
      if (txnDate > asOfDate) return false;
      return String(row.remarks).trim().toLowerCase() === 'available balance';
    });
    const latestAvailableBalanceRow =
      availableBalanceRows.length > 0
        ? availableBalanceRows[availableBalanceRows.length - 1]
        : null;
    const mainAvailableBalance = latestAvailableBalanceRow
      ? formatAmount(latestAvailableBalanceRow.balance)
      : totalBalance;
    const availableBalance = mainAvailableBalance;

    const statementTotals = null;
    const statementMeta = null;
    const statementStatus = 'disabled';
    const statementError = null;

    res.json({
      success: true,
      data: {
        asOfDate,
        totalBalance,
        mainAvailableBalance,
        availableBalance,
        totalCredit,
        totalDebit,
        // Bank statement parsing is intentionally disabled; totals come from transactions table only.
        statementTotals,
        statementMeta,
        statementStatus,
        statementError,
        totalsSource: 'transactions',
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

