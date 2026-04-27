const express = require('express');
const { pool } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const DailyBankStatement = require('../models/DailyBankStatement');
const { parseStatementTotalsFromPdfPath } = require('../utils/parseStatementTotalsFromPdf');
const { formatAmount, roundToTwoDecimals } = require('../utils/formatAmount');
const {
  isCustomerPdcType,
  isGcecPdcType,
  parseDailyLedgerApproved,
  shouldPdcAffectBalance
} = require('../utils/pdcLedgerApproval');

const router = express.Router();

function hasExtractedAmounts(extracted) {
  return extracted
    && (extracted.totalDebitAmount != null
      || extracted.totalCreditAmount != null
      || extracted.ledgerBalance != null);
}

function formatStatementTotals(extracted) {
  if (!hasExtractedAmounts(extracted)) return null;
  return {
    totalDebitAmount: extracted.totalDebitAmount != null ? formatAmount(extracted.totalDebitAmount) : null,
    totalCreditAmount: extracted.totalCreditAmount != null ? formatAmount(extracted.totalCreditAmount) : null,
    ledgerBalance: extracted.ledgerBalance != null ? formatAmount(extracted.ledgerBalance) : null
  };
}

function getStatementTotalsFromRecord(record) {
  if (!record) return null;
  const extracted = {
    totalDebitAmount: record.statement_total_debit_amount != null ? Number(record.statement_total_debit_amount) : null,
    totalCreditAmount: record.statement_total_credit_amount != null ? Number(record.statement_total_credit_amount) : null,
    ledgerBalance: record.statement_ledger_balance != null ? Number(record.statement_ledger_balance) : null
  };
  return formatStatementTotals(extracted);
}

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
    const useStatementTotals = String(req.query.useStatementTotals || '').toLowerCase() === 'true';

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
      AND UPPER(TRIM(COALESCE(pdc.cheque_type, ''))) <> 'SECURITY CHEQUE'
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

    let statementTotals = null;
    let statementMeta = null;
    let statementStatus = 'not_found';
    let statementError = null;
    try {
      const currentStatement = await DailyBankStatement.getCurrent();
      if (currentStatement) {
        statementMeta = {
          uploadedAt: currentStatement.uploaded_at || null,
          updatedAt: currentStatement.updated_at || null,
          originalFilename: currentStatement.original_filename || null
        };
        statementStatus = 'found';

        statementTotals = getStatementTotalsFromRecord(currentStatement);
        if (statementTotals) {
          statementStatus = 'parsed';
        } else {
          const readablePath = await DailyBankStatement.resolveReadableFilePath(currentStatement);
          if (!readablePath) {
            statementStatus = 'file_missing';
            statementError = 'Daily statement file is missing on server storage';
          } else {
          const extracted = await parseStatementTotalsFromPdfPath(readablePath);
          const formattedTotals = formatStatementTotals(extracted);
          if (formattedTotals) {
            statementTotals = formattedTotals;
            statementStatus = 'parsed';
          } else {
            statementStatus = 'parsed_no_totals';
          }
        }
        }
      }
    } catch (statementParseError) {
      statementStatus = 'parse_failed';
      statementError = statementParseError.message || 'Failed to parse daily statement';
      console.error('Failed to parse daily bank statement totals for account summary:', statementParseError.message);
    }

    const effectiveTotalCredit =
      useStatementTotals && statementTotals?.totalCreditAmount != null
        ? statementTotals.totalCreditAmount
        : totalCredit;
    const effectiveTotalDebit =
      useStatementTotals && statementTotals?.totalDebitAmount != null
        ? statementTotals.totalDebitAmount
        : totalDebit;
    const effectiveTotalBalance =
      useStatementTotals && statementTotals?.ledgerBalance != null
        ? statementTotals.ledgerBalance
        : totalBalance;

    res.json({
      success: true,
      data: {
        asOfDate,
        totalBalance: effectiveTotalBalance,
        mainAvailableBalance,
        availableBalance,
        totalCredit: effectiveTotalCredit,
        totalDebit: effectiveTotalDebit,
        // Dashboard can directly render these values from latest uploaded daily statement file.
        statementTotals,
        statementMeta,
        statementStatus,
        statementError,
        totalsSource: useStatementTotals && statementTotals ? 'statement' : 'transactions',
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

