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
const { isAvailableBalanceRemarks } = require('../utils/availableBalanceRemarks');

const router = express.Router();

function hasExtractedAmounts(extracted) {
  return extracted
    && (extracted.totalDebitAmount != null
      || extracted.totalCreditAmount != null
      || extracted.currentBalance != null
      || extracted.ledgerBalance != null);
}

function formatStatementTotals(extracted) {
  if (!hasExtractedAmounts(extracted)) return null;
  const currentBalanceRaw = extracted.currentBalance ?? extracted.ledgerBalance;
  return {
    totalDebitAmount: extracted.totalDebitAmount != null ? formatAmount(extracted.totalDebitAmount) : null,
    totalCreditAmount: extracted.totalCreditAmount != null ? formatAmount(extracted.totalCreditAmount) : null,
    currentBalance: currentBalanceRaw != null ? formatAmount(currentBalanceRaw) : null,
    closingAvailableBalance: extracted.closingAvailableBalance != null
      ? formatAmount(extracted.closingAvailableBalance)
      : null,
    ledgerBalance: currentBalanceRaw != null ? formatAmount(currentBalanceRaw) : null
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

async function resolveStatementTotalsFromDailyPdf(currency = 'AED') {
  const currentStatement = await DailyBankStatement.getCurrent(currency);
  if (!currentStatement) {
    return {
      statementTotals: null,
      statementMeta: null,
      statementStatus: 'not_found',
      statementError: null
    };
  }

  const statementMeta = {
    currency,
    uploadedAt: currentStatement.uploaded_at || null,
    updatedAt: currentStatement.updated_at || null,
    originalFilename: currentStatement.original_filename || null
  };

  const readablePath = await DailyBankStatement.resolveReadableFilePath(currentStatement);
  if (readablePath) {
    const extracted = await parseStatementTotalsFromPdfPath(readablePath);
    const formattedTotals = formatStatementTotals(extracted);
    if (formattedTotals?.currentBalance != null) {
      return { statementTotals: formattedTotals, statementMeta, statementStatus: 'parsed', statementError: null };
    }
    if (formattedTotals) {
      return {
        statementTotals: formattedTotals,
        statementMeta,
        statementStatus: 'parsed_no_totals',
        statementError: 'Current balance not found in uploaded PDF'
      };
    }
  }

  const cachedTotals = getStatementTotalsFromRecord(currentStatement);
  if (cachedTotals?.currentBalance != null) {
    return { statementTotals: cachedTotals, statementMeta, statementStatus: 'parsed', statementError: null };
  }

  if (!readablePath) {
    return {
      statementTotals: cachedTotals,
      statementMeta,
      statementStatus: 'file_missing',
      statementError: 'Daily statement file is missing on server storage'
    };
  }

  return {
    statementTotals: cachedTotals,
    statementMeta,
    statementStatus: 'parsed_no_totals',
    statementError: 'Current balance not found in uploaded PDF'
  };
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

async function fetchLatestStoredAvailableBalance(asOfDate) {
  const result = await pool.query(
    `SELECT balance
     FROM transactions
     WHERE LOWER(TRIM(COALESCE(remarks, ''))) LIKE '%available balance%'
       AND date <= ?
     ORDER BY date DESC, transaction_time DESC, id DESC
     LIMIT 1`,
    [asOfDate]
  );
  if (result.rows.length === 0) return null;
  return formatAmount(result.rows[0].balance);
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
        const isUpcomingDailyTransitionPdc = rowDate > todayYmd;
        const isGcec = isGcecPdcType(pdc.pdc_type);
        // Match /api/transactions mapPdcMaturedToSyntheticRow includeInBalance rules.
        const shouldAffectBalance = isUpcomingDailyTransitionPdc
          ? isGcec
          : isCustomerPdc
            ? true
            : shouldPdcAffectBalance(pdc.pdc_type, pdc.daily_ledger_approved);
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
      return isAvailableBalanceRemarks(row.remarks);
    });
    const latestAvailableBalanceRow =
      availableBalanceRows.length > 0
        ? availableBalanceRows[availableBalanceRows.length - 1]
        : null;
    let statementTotals = null;
    let statementMeta = null;
    let statementStatus = 'not_found';
    let statementError = null;
    try {
      ({
        statementTotals,
        statementMeta,
        statementStatus,
        statementError
      } = await resolveStatementTotalsFromDailyPdf('AED'));
    } catch (statementParseError) {
      statementStatus = 'parse_failed';
      statementError = statementParseError.message || 'Failed to parse daily bank statement PDF';
      console.error('Failed to parse daily bank statement for account summary:', statementParseError.message);
    }

    // Current balance: bank statement PDF (Current / Closing balance labels).
    const currentBalance = statementTotals?.currentBalance ?? null;
    // Available balance: latest ledger row whose remarks contain "Available Balance"
    // (same marker as GET /api/transactions), with stored DB / statement fallbacks.
    let mainAvailableBalance = latestAvailableBalanceRow
      ? formatAmount(latestAvailableBalanceRow.balance)
      : '0.00';
    if (mainAvailableBalance === '0.00') {
      const storedAvailableBalance = await fetchLatestStoredAvailableBalance(asOfDate);
      if (storedAvailableBalance && storedAvailableBalance !== '0.00') {
        mainAvailableBalance = storedAvailableBalance;
      }
    }
    if (
      useStatementTotals
      && statementTotals?.closingAvailableBalance
      && (mainAvailableBalance === '0.00' || !latestAvailableBalanceRow)
    ) {
      mainAvailableBalance = statementTotals.closingAvailableBalance;
    }
    const availableBalance = mainAvailableBalance;
    // Legacy: ?useStatementTotals=true maps totalBalance to PDF current balance for older clients.
    const responseTotalBalance = useStatementTotals && currentBalance
      ? currentBalance
      : totalBalance;

    res.json({
      success: true,
      data: {
        asOfDate,
        totalBalance: responseTotalBalance,
        ledgerBalance: totalBalance,
        currentBalance,
        mainAvailableBalance,
        availableBalance,
        totalCredit,
        totalDebit,
        statementTotals,
        statementMeta,
        statementStatus,
        statementError,
        currentBalanceSource: currentBalance ? 'statement' : null,
        totalsSource: useStatementTotals && currentBalance ? 'statement' : 'transactions',
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

