const express = require('express');
const Transaction = require('../models/Transaction');
const { authenticateToken } = require('../middleware/auth');
const { requireElevatedForMutation } = require('../middleware/requireElevatedForMutation');
const { USER_ROLES } = require('../constants/roles');
const {
  queueTransactionDelete,
  queueTransactionPut,
} = require('../controllers/transactionChangeRequestQueue');
const { formatAmount, roundToTwoDecimals, parseLooseAmount } = require('../utils/formatAmount');
const { pool } = require('../config/database');
const {
  isGcecPdcType,
  isCustomerPdcType,
  parseDailyLedgerApproved,
  shouldPdcAffectBalance
} = require('../utils/pdcLedgerApproval');
const PDC = require('../models/PDC');
const PurchaseBill = require('../models/PurchaseBill');
const {
  parseBankLedgerBulkCsvBuffer,
  paymentFromDetails
} = require('../utils/parseBankLedgerBulkCsv');
const { uploadBankLedgerCsv } = require('../middleware/bankLedgerCsvUpload');

const router = express.Router();

const PDC_DUE_ID_RE = /^pdc-due-(\d+)$/i;
const AVAILABLE_BALANCE_BG_COLOR = '#91d34d';

/** Normalize DB/JS dates to YYYY-MM-DD for sorting and comparison */
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

function getBalanceCellBgColorByRemarks(remarks) {
  const normalized = (remarks == null ? '' : String(remarks)).trim().toLowerCase();
  if (!normalized) return null;
  return normalized.includes('available balance') ? AVAILABLE_BALANCE_BG_COLOR : null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

/**
 * Edit forms may send full remarks like "GCEC PDC, note text".
 * Store only the latest free-text note in post_dated_cheques.description.
 */
function normalizePdcDescriptionInput(rawDescription, pdcType) {
  if (rawDescription == null) return null;
  const trimmed = String(rawDescription).trim();
  if (!trimmed) return null;
  const normalizedType = String(pdcType || '').trim().toLowerCase();
  if (normalizedType && trimmed.toLowerCase() === normalizedType) {
    return null;
  }
  const typePrefix = `${String(pdcType || '').trim()},`;
  if (typePrefix !== ',' && trimmed.startsWith(typePrefix)) {
    const withoutPrefix = trimmed.slice(typePrefix.length).trim();
    return withoutPrefix || null;
  }
  return trimmed;
}

function buildPdcRemarks(pdcType, description, { hideTypeFallback = false } = {}) {
  const desc = description == null ? '' : String(description).trim();
  if (desc) return desc;
  if (hideTypeFallback) return null;
  const typeText = pdcType == null ? '' : String(pdcType).trim();
  return typeText || null;
}

function getOrderTimestampMs(row) {
  if (!row) return 0;
  if (row.transactionTime) {
    const datePart = toYmd(row.date) || toYmd(new Date());
    const candidate = new Date(`${datePart}T${String(row.transactionTime)}`);
    const msFromTime = candidate.getTime();
    if (Number.isFinite(msFromTime)) return msFromTime;
  }
  const isApprovedCustomerPdc =
    (row.transactionType === 'Customer PDC' || isCustomerPdcType(row.pdcType)) &&
    row.dailyLedgerApproved === true &&
    row.dailyLedgerApprovedAt;
  const primary = isApprovedCustomerPdc ? row.dailyLedgerApprovedAt : row.createdAt;
  const ms = primary ? new Date(primary).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function formatTimestampForDisplay(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

/**
 * Daily transition PDC rows:
 * - all matured PDC (cheque_date <= today) for GCEC/Customer/Custom
 * Optional startDate/endDate filter on cheque_date (for /all); omit for full history on GET /.
 */
async function fetchPdcRowsMaturedForDailyLedger({ startDate, endDate } = {}) {
  const conditions = [
    `(pdc.cheque_date <= CURDATE() AND pdc.pdc_type IN ('GCEC PDC', 'Customer PDC', 'Custom PDC'))`,
    `UPPER(TRIM(COALESCE(pdc.cheque_type, ''))) <> 'SECURITY CHEQUE'`
  ];
  const params = [];
  if (startDate) {
    conditions.push('pdc.cheque_date >= ?');
    params.push(startDate);
  }
  if (endDate) {
    conditions.push('pdc.cheque_date <= ?');
    params.push(endDate);
  }
  const r = await pool.query(
    `
    SELECT
      pdc.id,
      DATE_FORMAT(pdc.cheque_date, '%Y-%m-%d') AS cheque_date_ymd,
      COALESCE(pdc.daily_ledger_approved, 0) AS daily_ledger_approved,
      pdc.daily_ledger_approved_at,
      pdc.cheque_number,
      pdc.customer_name,
      pdc.amount,
      pdc.cheque_type,
      pdc.pdc_type,
      pdc.description,
      pdc.created_by,
      u.username AS created_by_username,
      pdc.created_at
    FROM post_dated_cheques pdc
    LEFT JOIN users u ON pdc.created_by = u.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY pdc.cheque_date ASC, pdc.created_at ASC, pdc.id ASC
    `,
    params
  );
  return r.rows;
}

function mapPdcMaturedToSyntheticRow(pdc, { transactionType } = {}) {
  const isCustomerPdc = isCustomerPdcType(pdc.pdc_type);
  const isGcec = isGcecPdcType(pdc.pdc_type);
  const rowDate = pdc.cheque_date_ymd || toYmd(pdc.cheque_date);
  const todayYmd = toYmd(new Date());
  const isUpcomingDailyTransitionPdc = rowDate > todayYmd;
  const ledgerApprovalRequired = isGcec || isCustomerPdc;
  const approvalRelevantNow = ledgerApprovalRequired && !isUpcomingDailyTransitionPdc;
  const ledgerApproved = ledgerApprovalRequired
    ? parseDailyLedgerApproved(pdc.daily_ledger_approved)
    : true;
  // Approved Customer PDC should look like a regular transaction row:
  // use only free-text description and do not fallback to "Customer PDC" label.
  const hideTypeFallback = isCustomerPdc && ledgerApproved;
  const remarks = buildPdcRemarks(pdc.pdc_type, pdc.description, { hideTypeFallback });
  // GCEC PDC: before cheque date show as credit; on/after cheque date show as debit.
  // Customer PDC: always show as credit in daily transactions.
  const isCredit = (isGcec && rowDate > todayYmd) || isCustomerPdc;
  // Future-date transition row should not affect running balance directly.
  const includeInBalance = isUpcomingDailyTransitionPdc
    ? false
    : isCustomerPdc
      ? ledgerApproved
      : shouldPdcAffectBalance(pdc.pdc_type, pdc.daily_ledger_approved);
  const debitValue = !isCredit ? formatAmount(pdc.amount) : null;
  const creditValue = isCredit ? formatAmount(pdc.amount) : null;
  const pendingNoDateCredit =
    isUpcomingDailyTransitionPdc && isCredit ? formatAmount(pdc.amount) : null;
  const base = {
    id: `pdc-due-${pdc.id}`,
    date: rowDate,
    transactionTime: isCustomerPdc ? '09:00:00' : '00:00:00',
    category: pdc.customer_name || '-',
    paymentType: 'cheque',
    chequeNumber: pdc.cheque_number || '-',
    debit: debitValue,
    credit: creditValue,
    balance: null,
    remarks,
    balanceCellBgColor: getBalanceCellBgColorByRemarks(remarks),
    createdBy: pdc.created_by,
    createdByUsername: pdc.created_by_username || null,
    createdAt: pdc.created_at,
    dailyLedgerApprovedAt: pdc.daily_ledger_approved_at || null,
    dailyLedgerApprovedAtDisplay: formatTimestampForDisplay(pdc.daily_ledger_approved_at),
    pdcId: pdc.id,
    pdcType: pdc.pdc_type,
    isUpcomingDailyTransitionPdc,
    syntheticFromPdc: true,
    ledgerApprovalRequired: approvalRelevantNow,
    ledgerApproved,
    affectsBalance: includeInBalance,
    showLedgerApprovalCheckbox: approvalRelevantNow && !ledgerApproved,
    // Frontend should treat this separately from the dated future row:
    // apply only on the no-date duplicate row.
    pendingNoDateCredit,
    /** Explicit flag for UI — use this or showLedgerApprovalCheckbox (do not rely on remarks text alone) */
    pendingGcecLedgerApproval: approvalRelevantNow && !ledgerApproved,
    /** When true, UI may clone this row at table end (no date on clone); backend sends this row once only */
    ledgerApprovalFooterDuplicateForUi:
      isUpcomingDailyTransitionPdc || (approvalRelevantNow && !ledgerApproved),
    showAtDailyTransitionEnd: isUpcomingDailyTransitionPdc
  };
  if (transactionType) {
    return { ...base, transactionType };
  }
  return base;
}

function sortMergedByDateThenId(rows) {
  return [...rows].sort((a, b) => {
    const da = toYmd(a.date);
    const db = toYmd(b.date);
    if (da !== db) return da.localeCompare(db);
    const aOrderMs = getOrderTimestampMs(a);
    const bOrderMs = getOrderTimestampMs(b);
    if (aOrderMs !== bOrderMs) return aOrderMs - bOrderMs;
    const ida = typeof a.id === 'number' ? a.id : Number.MAX_SAFE_INTEGER;
    const idb = typeof b.id === 'number' ? b.id : Number.MAX_SAFE_INTEGER;
    if (ida !== idb) return ida - idb;
    return String(a.id).localeCompare(String(b.id));
  });
}

function deriveDateRangeFromRows(rows) {
  const ymd = [];
  for (const row of rows || []) {
    const d = toYmd(row && row.date);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) ymd.push(d);
  }
  if (ymd.length === 0) return { startDate: null, endDate: null };
  ymd.sort();
  return { startDate: ymd[0], endDate: ymd[ymd.length - 1] };
}

/**
 * Running balance for merged list (DB transactions + synthetic PDC). Same rules as Transaction.recalculateAllBalances.
 * Mutates each row's `balance`. Includes normal rows (bounced/returned cheques, etc.) when they exist as ledger transactions.
 */
async function applyRunningBalancesToMainRows(mainRows) {
  if (!mainRows.length) return;
  const firstYmd = toYmd(mainRows[0].date);
  let running = await Transaction.getBalanceBeforeDate(firstYmd);
  for (const row of mainRows) {
    if (row.affectsBalance === false) {
      row.balance = formatAmount(running);
      continue;
    }
    let debitAmt = 0;
    let creditAmt = 0;
    if (row.debit != null && row.debit !== '') {
      const x = parseFloat(String(row.debit));
      if (!Number.isNaN(x) && x > 0) debitAmt = x;
    }
    if (row.credit != null && row.credit !== '') {
      const x = parseFloat(String(row.credit));
      if (!Number.isNaN(x) && x > 0) creditAmt = x;
    }
    if (debitAmt > 0) running = roundToTwoDecimals(running - debitAmt);
    if (creditAmt > 0) running = roundToTwoDecimals(running + creditAmt);
    row.balance = formatAmount(running);
  }
}

// Get all transactions with filters (Daily transactions, GCEC PDC, Customer PDC, Purchase Bills)
router.get('/all', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Build date filter conditions and parameters (MySQL placeholders)
    const buildDateFilter = (dateColumn) => {
      const conditions = [];
      const params = [];

      if (startDate) {
        conditions.push(`${dateColumn} >= ?`);
        params.push(startDate);
      }
      if (endDate) {
        conditions.push(`${dateColumn} <= ?`);
        params.push(endDate);
      }

      return {
        whereClause: conditions.length > 0 ? conditions.join(' AND ') : '',
        params
      };
    };

    // 1. Get Daily transactions
    const txnDateFilter = buildDateFilter('t.date');
    const transactionsQuery = `
      SELECT 
        t.id,
        t.date,
        t.transaction_time,
        t.type,
        t.category_id,
        t.category_type,
        COALESCE(pc.name, rc.name) as category_name,
        t.payment_type,
        t.cheque_number,
        t.amount,
        t.balance,
        t.remarks,
        t.created_by,
        u.username as created_by_username,
        t.created_at,
        'Daily Transaction' as transaction_type
      FROM transactions t
      LEFT JOIN payables_categories pc ON t.category_id = pc.id AND t.category_type = 'payable'
      LEFT JOIN receivables_categories rc ON t.category_id = rc.id AND t.category_type = 'receivable'
      LEFT JOIN users u ON t.created_by = u.id
      ${txnDateFilter.whereClause ? `WHERE ${txnDateFilter.whereClause}` : ''}
      ORDER BY t.date ASC, t.transaction_time ASC, t.id ASC
    `;
    const transactionsResult = await pool.query(transactionsQuery, txnDateFilter.params);
    let dailyTransactionsBase = transactionsResult.rows.map(txn => ({
      id: txn.id,
      date: txn.date,
      transactionTime: txn.transaction_time || '00:00:00',
      category: txn.category_name || '-',
      paymentType: txn.payment_type,
      chequeNumber: txn.cheque_number || '-',
      debit: txn.type === 'Debit' ? formatAmount(txn.amount) : null,
      credit: txn.type === 'Credit' ? formatAmount(txn.amount) : null,
      balance: formatAmount(txn.balance),
      remarks: txn.remarks || null,
      balanceCellBgColor: getBalanceCellBgColorByRemarks(txn.remarks),
      createdBy: txn.created_by,
      createdByUsername: txn.created_by_username || null,
      createdAt: txn.created_at
    }));

    // PDCs whose cheque date has arrived: Daily Transaction rows dated as cheque_date (same range as filters when set)
    const pdcRows = await fetchPdcRowsMaturedForDailyLedger({
      startDate,
      endDate
    });
    const pdcAsDailyBase = pdcRows.map((pdc) => mapPdcMaturedToSyntheticRow(pdc));
    const mainDailyRows = sortMergedByDateThenId([...dailyTransactionsBase, ...pdcAsDailyBase]);
    await applyRunningBalancesToMainRows(mainDailyRows);
    dailyTransactionsBase = mainDailyRows;
    const dailyTransactions = dailyTransactionsBase.map((row) => ({
      ...row,
      transactionType: 'Daily Transaction'
    }));

    // 2. Get GCEC PDC
    const gcecPdcDateFilter = buildDateFilter('pdc.cheque_date');
    const gcecPdcQuery = `
      SELECT 
        pdc.id,
        DATE_FORMAT(pdc.cheque_date, '%Y-%m-%d') as date,
        pdc.cheque_number,
        pdc.customer_name,
        pdc.amount,
        pdc.cheque_type,
        pdc.pdc_type,
        pdc.description,
        pdc.created_by,
        u.username as created_by_username,
        pdc.created_at,
        'GCEC PDC' as transaction_type
      FROM post_dated_cheques pdc
      LEFT JOIN users u ON pdc.created_by = u.id
      WHERE pdc.pdc_type = 'GCEC PDC'
        AND pdc.cheque_date > CURDATE()
      ${gcecPdcDateFilter.whereClause ? `AND ${gcecPdcDateFilter.whereClause}` : ''}
      ORDER BY pdc.cheque_date ASC, pdc.created_at ASC
    `;
    const gcecPdcResult = await pool.query(gcecPdcQuery, gcecPdcDateFilter.params);
    const gcecPdcs = gcecPdcResult.rows.map(pdc => ({
      id: pdc.id,
      date: pdc.date,
      transactionTime: '00:00:00',
      transactionType: 'GCEC PDC',
      customerName: pdc.customer_name,
      chequeNumber: pdc.cheque_number,
      chequeType: pdc.cheque_type,
      amount: formatAmount(pdc.amount),
      description: pdc.description || null,
      createdBy: pdc.created_by,
      createdByUsername: pdc.created_by_username || null,
      createdAt: pdc.created_at
    }));

    // 3. Get Customer PDC
    const customerPdcDateFilter = buildDateFilter('pdc.cheque_date');
    const customerPdcQuery = `
      SELECT 
        pdc.id,
        DATE_FORMAT(pdc.cheque_date, '%Y-%m-%d') as date,
        pdc.cheque_number,
        pdc.customer_name,
        pdc.amount,
        pdc.cheque_type,
        pdc.pdc_type,
        COALESCE(pdc.daily_ledger_approved, 0) AS daily_ledger_approved,
        pdc.daily_ledger_approved_at,
        pdc.description,
        pdc.created_by,
        u.username as created_by_username,
        pdc.created_at,
        'Customer PDC' as transaction_type
      FROM post_dated_cheques pdc
      LEFT JOIN users u ON pdc.created_by = u.id
      WHERE pdc.pdc_type = 'Customer PDC'
        AND (
          pdc.cheque_date > CURDATE()
          OR UPPER(TRIM(COALESCE(pdc.cheque_type, ''))) = 'SECURITY CHEQUE'
        )
      ${customerPdcDateFilter.whereClause ? `AND ${customerPdcDateFilter.whereClause}` : ''}
      ORDER BY pdc.cheque_date ASC, pdc.created_at ASC
    `;
    const customerPdcResult = await pool.query(customerPdcQuery, customerPdcDateFilter.params);
    const customerPdcs = customerPdcResult.rows.map(pdc => {
      const ledgerApproved = parseDailyLedgerApproved(pdc.daily_ledger_approved);
      return {
        id: pdc.id,
        date: pdc.date,
        transactionTime: '09:00:00',
        transactionType: 'Customer PDC',
        customerName: pdc.customer_name,
        chequeNumber: pdc.cheque_number,
        chequeType: pdc.cheque_type,
        debit: null,
        credit: formatAmount(pdc.amount),
        amount: formatAmount(pdc.amount),
        description: pdc.description || null,
        dailyLedgerApproved: ledgerApproved,
        dailyLedgerApprovedAt: pdc.daily_ledger_approved_at || null,
        affectsBalance: ledgerApproved,
        pendingBalanceEffect: !ledgerApproved,
        createdBy: pdc.created_by,
        createdByUsername: pdc.created_by_username || null,
        createdAt: pdc.created_at
      };
    });

    // 4. Get Purchase Bills
    const purchaseBillDateFilter = buildDateFilter('pb.bill_date');
    const purchaseBillQuery = `
      SELECT 
        pb.id,
        DATE_FORMAT(pb.bill_date, '%Y-%m-%d') as date,
        pb.invoice_number,
        pb.vendor_name,
        pb.bill_number,
        pb.payment_method,
        pb.amount,
        pb.description,
        pb.payment_status,
        pb.created_by,
        u.username as created_by_username,
        pb.created_at,
        pb.updated_at,
        'Purchase Bill' as transaction_type
      FROM purchase_bills pb
      LEFT JOIN users u ON pb.created_by = u.id
      ${purchaseBillDateFilter.whereClause ? `WHERE ${purchaseBillDateFilter.whereClause}` : ''}
      ORDER BY pb.bill_date ASC, pb.created_at ASC
    `;
    const purchaseBillResult = await pool.query(purchaseBillQuery, purchaseBillDateFilter.params);
    const purchaseBills = purchaseBillResult.rows.map(bill => ({
      id: bill.id,
      date: bill.date,
      transactionTime: '00:00:00',
      transactionType: 'Purchase Bill',
      vendorName: bill.vendor_name || null,
      invoiceNumber: bill.invoice_number || null,
      billNumber: bill.bill_number || null,
      paymentMethod: bill.payment_method || null,
      amount: formatAmount(bill.amount),
      description: bill.description || null,
      paymentStatus: bill.payment_status || null,
      createdBy: bill.created_by,
      createdByUsername: bill.created_by_username || null,
      createdAt: bill.created_at
    }));

    const allTransactions = [
      ...dailyTransactions,
      ...gcecPdcs,
      ...customerPdcs,
      ...purchaseBills
    ];
    const orderedAllTransactions = sortMergedByDateThenId(allTransactions);

    const derivedRange = deriveDateRangeFromRows(orderedAllTransactions);
    const dailyRowsWithBalance = orderedAllTransactions.filter(
      (row) => row.transactionType === 'Daily Transaction' && row.balance != null
    );
    const currentBalance =
      dailyRowsWithBalance.length > 0
        ? dailyRowsWithBalance[dailyRowsWithBalance.length - 1].balance
        : '0.00';
    res.json({
      success: true,
      data: orderedAllTransactions,
      transactions: dailyTransactionsBase,
      currentBalance,
      totalTransactions: orderedAllTransactions.length,
      summary: {
        dailyTransactions: dailyTransactions.length,
        gcecPdc: gcecPdcs.length,
        customerPdc: customerPdcs.length,
        purchaseBills: purchaseBills.length,
        total: orderedAllTransactions.length
      },
      filters: {
        startDate: startDate || derivedRange.startDate,
        endDate: endDate || derivedRange.endDate
      }
    });
  } catch (error) {
    console.error('Error fetching all transactions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch transactions',
      details: error.message
    });
  }
});

// Get all transactions (table format) — includes matured PDCs as synthetic rows on their cheque_date (same rules as /all daily list)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const transactions = await Transaction.getAll();

    // Format response to match table layout
    let formattedTransactions = transactions.map(txn => ({
      id: txn.id,
      date: txn.date,
      transactionTime: txn.transaction_time || '00:00:00',
      category: txn.category_name || '-',
      paymentType: txn.payment_type,
      chequeNumber: txn.cheque_number || '-',
      debit: txn.type === 'Debit' ? formatAmount(txn.amount) : null,
      credit: txn.type === 'Credit' ? formatAmount(txn.amount) : null,
      balance: formatAmount(txn.balance),
      remarks: txn.remarks || null,
      balanceCellBgColor: getBalanceCellBgColorByRemarks(txn.remarks),
      createdBy: txn.created_by,
      createdByUsername: txn.created_by_username || null,
      createdAt: txn.created_at
    }));

    const pdcRows = await fetchPdcRowsMaturedForDailyLedger();
    const synthetic = pdcRows.map((pdc) => mapPdcMaturedToSyntheticRow(pdc));
    const rowsForRunningBalance = sortMergedByDateThenId([...formattedTransactions, ...synthetic]);
    await applyRunningBalancesToMainRows(rowsForRunningBalance);
    formattedTransactions = rowsForRunningBalance;

    const lastDailyRowWithBalance = [...rowsForRunningBalance]
      .reverse()
      .find((row) => row.balance != null);
    const currentBalance = lastDailyRowWithBalance
      ? lastDailyRowWithBalance.balance
      : rowsForRunningBalance.length > 0
        ? rowsForRunningBalance[rowsForRunningBalance.length - 1].balance
        : '0.00';

    res.json({
      success: true,
      data: formattedTransactions,
      currentBalance: currentBalance,
      totalTransactions: formattedTransactions.length
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch transactions'
    });
  }
});

const MAX_BULK_TRANSACTIONS = 500;

/** Without ?full=1, bulk APIs skip N getById calls (faster response after import). */
function bulkWantFullRowPayload(req) {
  const q = req.query || {};
  return (
    q.full === '1' ||
    q.full === 'true' ||
    q.details === '1' ||
    String(req.headers['x-bulk-full-response'] || '') === '1'
  );
}

function addScalarBulkDeleteTarget(value, ledgerIds, pdcIds, invalid, source, index) {
  if (value == null || value === '') {
    invalid.push({ source, index, error: 'Empty value' });
    return;
  }
  const s = String(value).trim();
  const m = PDC_DUE_ID_RE.exec(s);
  if (m) {
    pdcIds.add(parseInt(m[1], 10));
    return;
  }
  const n = parseInt(value, 10);
  if (Number.isInteger(n) && n > 0) {
    ledgerIds.add(n);
    return;
  }
  invalid.push({
    source,
    index,
    value,
    error: 'Must be a positive ledger id or a synthetic id like pdc-due-123'
  });
}

function transactionTypeLabel(row) {
  const r = row || {};
  if (r.transactionType != null) return String(r.transactionType).trim();
  if (r.transaction_type != null) return String(r.transaction_type).trim();
  return '';
}

function addRowBulkDeleteTargets(
  row,
  ledgerIds,
  pdcIds,
  purchaseBillIds,
  invalid,
  source,
  index
) {
  const r = row || {};
  const tt = transactionTypeLabel(r);
  const rawId = r.id != null ? r.id : r.Id;

  if (tt === 'GCEC PDC' || tt === 'Customer PDC' || tt === 'Custom PDC') {
    const n = parseInt(rawId, 10);
    if (Number.isInteger(n) && n > 0) {
      pdcIds.add(n);
      return;
    }
    invalid.push({
      source,
      index,
      value: rawId,
      error: 'GCEC/Customer/Custom PDC rows need a numeric post_dated_cheques id'
    });
    return;
  }

  if (tt === 'Purchase Bill') {
    const n = parseInt(rawId, 10);
    if (Number.isInteger(n) && n > 0) {
      purchaseBillIds.add(n);
      return;
    }
    invalid.push({
      source,
      index,
      value: rawId,
      error: 'Purchase Bill rows need a numeric purchase_bills id'
    });
    return;
  }

  // Daily Transaction, or rows without type (GET / main AED table)
  if (rawId != null && rawId !== '') {
    const s = String(rawId).trim();
    const m = PDC_DUE_ID_RE.exec(s);
    if (m) {
      pdcIds.add(parseInt(m[1], 10));
      return;
    }
    const n = parseInt(rawId, 10);
    if (Number.isInteger(n) && n > 0) {
      ledgerIds.add(n);
      return;
    }
    invalid.push({
      source,
      index,
      value: rawId,
      error: 'id must be a positive ledger id or pdc-due-* (matured PDC on daily list)'
    });
    return;
  }
  if (r.pdcId != null && r.pdcId !== '') {
    const pid = parseInt(r.pdcId, 10);
    if (Number.isInteger(pid) && pid > 0) {
      pdcIds.add(pid);
      return;
    }
  }
  invalid.push({
    source,
    index,
    error: 'Each row needs id (ledger, pdc-due-*, or typed id from /all) or pdcId for synthetic PDC'
  });
}

function normalizeTransactionDateInput(date) {
  if (date == null) return null;
  let formattedDate = date;
  if (String(date).includes('/')) {
    const [day, month, year] = String(date).split('/');
    formattedDate = `${year}-${month}-${day}`;
  }
  return formattedDate;
}

function normalizeTransactionTimeInput(time) {
  if (time == null || String(time).trim() === '') return '00:00:00';
  const raw = String(time).trim();
  const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) return null;
  const hh = match[1].padStart(2, '0');
  const mm = match[2];
  const ss = match[3] || '00';
  return `${hh}:${mm}:${ss}`;
}

async function ensurePayableCategoryIdForImport(name) {
  const n = String(name).trim();
  if (!n) {
    throw new Error('Description (payable name) is required for each row');
  }
  let r = await pool.query(
    'SELECT id FROM payables_categories WHERE LOWER(TRIM(name)) = LOWER(?) LIMIT 1',
    [n]
  );
  if (r.rows.length > 0) {
    return r.rows[0].id;
  }
  await pool.query('INSERT INTO payables_categories (name) VALUES (?)', [n]);
  r = await pool.query(
    'SELECT id FROM payables_categories WHERE LOWER(TRIM(name)) = LOWER(?) LIMIT 1',
    [n]
  );
  return r.rows[0].id;
}

async function ensureReceivableCategoryIdForImport(name) {
  const n = String(name).trim();
  if (!n) {
    throw new Error('Description (receivable name) is required for each row');
  }
  let r = await pool.query(
    'SELECT id FROM receivables_categories WHERE LOWER(TRIM(name)) = LOWER(?) LIMIT 1',
    [n]
  );
  if (r.rows.length > 0) {
    return r.rows[0].id;
  }
  await pool.query('INSERT INTO receivables_categories (name) VALUES (?)', [n]);
  r = await pool.query(
    'SELECT id FROM receivables_categories WHERE LOWER(TRIM(name)) = LOWER(?) LIMIT 1',
    [n]
  );
  return r.rows[0].id;
}

/** mysql2 may return BIGINT as bigint — JSON.stringify throws on BigInt */
function jsonSafeInt(v) {
  if (v == null || v === '') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function jsonSerializeReplacer(_key, val) {
  if (typeof val === 'bigint') return Number(val);
  if (
    val != null &&
    typeof val === 'object' &&
    typeof val.toISOString === 'function' &&
    typeof val.getTime === 'function' &&
    !Number.isNaN(val.getTime())
  ) {
    return val.toISOString();
  }
  return val;
}

/**
 * Guaranteed JSON body for bulk endpoints (BigInt / Date-safe). Avoids res.json() throwing after DB commit.
 */
function sendJsonResponse(res, statusCode, payload) {
  if (res.headersSent) {
    console.warn('sendJsonResponse: headers already sent', statusCode);
    return;
  }
  try {
    const body = JSON.stringify(payload, jsonSerializeReplacer);
    res.status(statusCode);
    res.type('application/json');
    res.send(body);
  } catch (e) {
    console.error('sendJsonResponse failed:', e);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Failed to serialize API response (check server logs)'
      });
    }
  }
}

function formatCreatedTransactionRow(transaction) {
  const createdRaw = transaction.created_at;
  let createdAt = createdRaw;
  if (
    createdRaw != null &&
    typeof createdRaw === 'object' &&
    typeof createdRaw.toISOString === 'function'
  ) {
    try {
      createdAt = createdRaw.toISOString();
    } catch (_) {
      createdAt = createdRaw;
    }
  }
  return {
    id: jsonSafeInt(transaction.id),
    date: transaction.date,
    transactionTime: transaction.transaction_time || '00:00:00',
    category: transaction.category_name || '-',
    paymentType: transaction.payment_type,
    chequeNumber: transaction.cheque_number || '-',
    debit: transaction.type === 'Debit' ? formatAmount(transaction.amount) : null,
    credit: transaction.type === 'Credit' ? formatAmount(transaction.amount) : null,
    balance: formatAmount(transaction.balance),
    remarks: transaction.remarks || null,
    balanceCellBgColor: getBalanceCellBgColorByRemarks(transaction.remarks),
    createdBy:
      transaction.created_by != null ? jsonSafeInt(transaction.created_by) : null,
    createdByUsername: transaction.created_by_username,
    createdAt
  };
}

/**
 * Bulk create daily transactions (AED ledger). Body: { transactions: [ ...same fields as POST / ] }
 * Rows apply after existing rows on each date, in array order within the batch.
 */
router.post('/bulk', authenticateToken, async (req, res) => {
  try {
    const raw =
      req.body && Array.isArray(req.body.transactions)
        ? req.body.transactions
        : null;

    if (!raw) {
      return res.status(400).json({
        success: false,
        error: 'Request body must include a "transactions" array'
      });
    }

    if (raw.length === 0) {
      return res.status(400).json({
        success: false,
        error: '"transactions" must not be empty'
      });
    }

    if (raw.length > MAX_BULK_TRANSACTIONS) {
      return res.status(400).json({
        success: false,
        error: `At most ${MAX_BULK_TRANSACTIONS} transactions per request`
      });
    }

    const validPaymentTypes = ['cash', 'cheque', 'creditcard', 'online', 'dd'];
    const errors = [];
    const normalized = [];

    for (let i = 0; i < raw.length; i++) {
      const row = raw[i];
      const {
        date,
        type,
        categoryId,
        category_id: category_id_snake,
        paymentType: paymentTypeRaw,
        payment_type: payment_type_snake,
        chequeNumber: chequeNumberRaw,
        cheque_number: cheque_number_snake,
        transactionTime: transactionTimeRaw,
        transaction_time: transaction_time_snake,
        time: timeRaw,
        amount,
        remarks,
        details,
        categoryName,
        category,
        description
      } = row || {};

      let paymentType = paymentTypeRaw ?? payment_type_snake;
      let chequeNumber = chequeNumberRaw ?? cheque_number_snake;
      const detailsVal = details;
      const transactionTimeValue =
        transactionTimeRaw ?? transaction_time_snake ?? timeRaw ?? '00:00:00';

      if (
        (!paymentType || String(paymentType).trim() === '') &&
        detailsVal != null &&
        String(detailsVal).trim() !== ''
      ) {
        const pay = paymentFromDetails(detailsVal);
        if (pay.error) {
          errors.push({ index: i, error: pay.error });
          continue;
        }
        paymentType = pay.paymentType;
        if (
          (!chequeNumber || String(chequeNumber).trim() === '') &&
          pay.chequeNumber
        ) {
          chequeNumber = pay.chequeNumber;
        }
      }

      if (!date || !type || !paymentType || amount == null || amount === '') {
        errors.push({
          index: i,
          error:
            'Date, type, amount, and paymentType (or details) are required'
        });
        continue;
      }

      if (type !== 'Debit' && type !== 'Credit') {
        errors.push({
          index: i,
          error: 'Type must be either "Debit" or "Credit"'
        });
        continue;
      }

      if (!validPaymentTypes.includes(String(paymentType).toLowerCase())) {
        errors.push({
          index: i,
          error: `Payment type must be one of: ${validPaymentTypes.join(', ')}`
        });
        continue;
      }

      if (
        String(paymentType).toLowerCase() === 'cheque' &&
        (!chequeNumber || String(chequeNumber).trim() === '')
      ) {
        errors.push({
          index: i,
          error: 'Cheque number is required when payment type is cheque'
        });
        continue;
      }

      const parsedAmount = parseLooseAmount(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        errors.push({
          index: i,
          error:
            'Amount must be greater than 0 (if pasted from Excel, remove thousands separators or use a plain number)'
        });
        continue;
      }

      const categoryIdVal = categoryId ?? category_id_snake;
      let parsedCategoryId = null;
      if (categoryIdVal != null && categoryIdVal !== '') {
        parsedCategoryId = parseInt(categoryIdVal, 10);
        if (!Number.isFinite(parsedCategoryId)) {
          errors.push({
            index: i,
            error: 'categoryId must be a number when provided'
          });
          continue;
        }
      } else {
        const nameCandidate = categoryName ?? category ?? description;
        if (nameCandidate != null && String(nameCandidate).trim() !== '') {
          try {
            parsedCategoryId =
              type === 'Debit'
                ? await ensurePayableCategoryIdForImport(
                    String(nameCandidate).trim()
                  )
                : await ensureReceivableCategoryIdForImport(
                    String(nameCandidate).trim()
                  );
          } catch (e) {
            errors.push({
              index: i,
              error: e.message || 'Failed to resolve category name'
            });
            continue;
          }
        }
      }

      const formattedDate = normalizeTransactionDateInput(date);
      const normalizedTransactionTime = normalizeTransactionTimeInput(
        transactionTimeValue
      );
      if (!normalizedTransactionTime) {
        errors.push({
          index: i,
          error: 'transactionTime must be in HH:mm or HH:mm:ss format'
        });
        continue;
      }
      normalized.push({
        date: formattedDate,
        transactionTime: normalizedTransactionTime,
        type,
        categoryId: parsedCategoryId,
        paymentType: String(paymentType).toLowerCase(),
        chequeNumber: chequeNumber || null,
        amount: roundToTwoDecimals(parsedAmount),
        remarks: remarks != null ? remarks : null
      });
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed for one or more rows',
        errors
      });
    }

    const createdBy = req.user ? req.user.id : null;
    const wantFull = bulkWantFullRowPayload(req);
    const created = await Transaction.createMany(normalized, createdBy, {
      fetchRows: wantFull
    });

    if (!wantFull) {
      sendJsonResponse(res, 200, {
        success: true,
        message: `${created.length} transaction(s) created successfully`,
        created: created.length,
        insertedIds: created.map((r) => jsonSafeInt(r.id)),
        hint: 'Pass ?full=1 to include formatted row objects in "data".'
      });
    } else {
      sendJsonResponse(res, 200, {
        success: true,
        message: `${created.length} transaction(s) created successfully`,
        created: created.length,
        data: created.map(formatCreatedTransactionRow)
      });
    }
  } catch (error) {
    console.error('Error bulk creating transactions:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to bulk create transactions'
    });
  }
});

/**
 * Bulk import daily transactions from a bank-style CSV:
 * Date, Description, Details, Debit, Credit, optional Remarks (Balance column ignored).
 * Details: DD, Online, Cash, or digits-only cheque number.
 */
router.post(
  '/bulk-csv',
  authenticateToken,
  (req, res, next) => {
    uploadBankLedgerCsv.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          success: false,
          error: err.message || 'File upload failed'
        });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({
          success: false,
          error: 'Missing file field "file" (.csv)'
        });
      }

      const { rows: parsedRows, errors: parseErrors } =
        parseBankLedgerBulkCsvBuffer(req.file.buffer);

      if (parseErrors.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'CSV validation failed',
          errors: parseErrors
        });
      }

      if (parsedRows.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No transactions to import'
        });
      }

      if (parsedRows.length > MAX_BULK_TRANSACTIONS) {
        return res.status(400).json({
          success: false,
          error: `At most ${MAX_BULK_TRANSACTIONS} transactions per file`
        });
      }

      const normalized = [];
      for (let i = 0; i < parsedRows.length; i++) {
        const pr = parsedRows[i];
        const categoryId =
          pr.type === 'Debit'
            ? await ensurePayableCategoryIdForImport(pr.description)
            : await ensureReceivableCategoryIdForImport(pr.description);

        normalized.push({
          date: pr.date,
          transactionTime: '00:00:00',
          type: pr.type,
          categoryId,
          paymentType: pr.paymentType,
          chequeNumber:
            pr.paymentType === 'cheque' ? pr.chequeNumber : null,
          amount: roundToTwoDecimals(pr.amount),
          remarks: pr.remarks
        });
      }

      const createdBy = req.user ? req.user.id : null;
      const wantFull = bulkWantFullRowPayload(req);
      const created = await Transaction.createMany(normalized, createdBy, {
        fetchRows: wantFull
      });

      if (!wantFull) {
        sendJsonResponse(res, 200, {
          success: true,
          message: `${created.length} transaction(s) imported from CSV`,
          created: created.length,
          insertedIds: created.map((r) => jsonSafeInt(r.id)),
          hint: 'Pass ?full=1 to include formatted row objects in "data".'
        });
      } else {
        sendJsonResponse(res, 200, {
          success: true,
          message: `${created.length} transaction(s) imported from CSV`,
          created: created.length,
          data: created.map(formatCreatedTransactionRow)
        });
      }
    } catch (error) {
      console.error('Transactions bulk CSV error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to import transactions from CSV'
      });
    }
  }
);

/**
 * Bulk delete what the daily transactions UI shows: AED `transactions` rows (numeric id)
 * and matured PDC lines (`id` like pdc-due-* or `pdcId` from GET /api/transactions).
 * Body options (same as list payload): { data: [...] } from GET, or { transactions: [...] },
 * or { ids: [1, "pdc-due-5", ...] }. Admin / accountant only.
 */
router.post(
  '/bulk-delete',
  authenticateToken,
  requireElevatedForMutation,
  async (req, res) => {
    try {
      const body = req.body || {};
      const invalid = [];
      const ledgerIds = new Set();
      const pdcIds = new Set();
      const purchaseBillIds = new Set();

      if (Array.isArray(body.ids)) {
        for (let i = 0; i < body.ids.length; i++) {
          addScalarBulkDeleteTarget(body.ids[i], ledgerIds, pdcIds, invalid, 'ids', i);
        }
      }

      const rowArrays = [
        ['transactions', body.transactions],
        ['data', body.data]
      ];
      for (const [sourceKey, arr] of rowArrays) {
        if (!Array.isArray(arr)) continue;
        for (let i = 0; i < arr.length; i++) {
          addRowBulkDeleteTargets(
            arr[i],
            ledgerIds,
            pdcIds,
            purchaseBillIds,
            invalid,
            sourceKey,
            i
          );
        }
      }

      const hasIds = Array.isArray(body.ids);
      const hasTransactions = Array.isArray(body.transactions);
      const hasData = Array.isArray(body.data);
      if (!hasIds && !hasTransactions && !hasData) {
        return res.status(400).json({
          success: false,
          error:
            'Request body must include "data" and/or "transactions" (row arrays from GET) and/or "ids"'
        });
      }

      if (invalid.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed for one or more rows/ids',
          invalid
        });
      }

      const totalUnique = ledgerIds.size + pdcIds.size + purchaseBillIds.size;
      if (totalUnique === 0) {
        return res.status(400).json({
          success: false,
          error: 'No valid ledger, PDC, or purchase bill targets to delete'
        });
      }

      if (totalUnique > MAX_BULK_TRANSACTIONS) {
        return res.status(400).json({
          success: false,
          error: `At most ${MAX_BULK_TRANSACTIONS} distinct rows per request (ledger + PDC + bills combined)`
        });
      }

      let deletedPurchaseBills = 0;
      const missingPurchaseBillIds = [];
      for (const bid of purchaseBillIds) {
        const ok = await PurchaseBill.delete(bid);
        if (ok) deletedPurchaseBills += 1;
        else missingPurchaseBillIds.push(bid);
      }

      let deletedPdc = 0;
      const missingPdcIds = [];
      for (const pid of pdcIds) {
        const ok = await PDC.delete(pid);
        if (ok) deletedPdc += 1;
        else missingPdcIds.push(pid);
      }

      const { deleted: deletedLedger, missingIds: missingLedgerIds } =
        ledgerIds.size > 0
          ? await Transaction.deleteManyByIds([...ledgerIds])
          : { deleted: 0, missingIds: [] };

      const deleted = deletedLedger + deletedPdc + deletedPurchaseBills;
      const hasMissing =
        missingLedgerIds.length > 0 ||
        missingPdcIds.length > 0 ||
        missingPurchaseBillIds.length > 0;

      const payload = {
        deleted,
        deletedLedger,
        deletedPdc,
        deletedPurchaseBills,
        missingLedgerIds,
        missingPdcIds,
        missingPurchaseBillIds,
        missingIds: missingLedgerIds
      };

      if (deleted === 0) {
        console.warn(
          'bulk-delete: no rows removed',
          JSON.stringify({
            requestedLedger: [...ledgerIds],
            requestedPdc: [...pdcIds],
            requestedPurchaseBills: [...purchaseBillIds],
            missingLedgerIds,
            missingPdcIds,
            missingPurchaseBillIds
          })
        );
        // 200 so axios/fetch error handlers do not swallow the JSON body
        return sendJsonResponse(res, 200, {
          success: false,
          error:
            'No rows were deleted. Ids may be wrong, rows may already be removed, or matured PDC lines need pdc-due-* id / pdcId from GET /api/transactions.',
          ...payload
        });
      }

      const partial = hasMissing && deleted > 0;
      sendJsonResponse(res, 200, {
        success: true,
        ...(partial
          ? {
              partial: true,
              warning:
                'Some selected rows were not deleted (not found or already removed). Check missingLedgerIds, missingPdcIds, missingPurchaseBillIds.'
            }
          : {}),
        message: `${deleted} row(s) deleted (${deletedLedger} ledger, ${deletedPdc} PDC, ${deletedPurchaseBills} purchase bill)`,
        ...payload
      });
    } catch (error) {
      console.error('Error bulk deleting transactions:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to bulk delete transactions'
      });
    }
  }
);

// Get a single transaction by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const transaction = await Transaction.getById(id);

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      data: {
        id: transaction.id,
        date: transaction.date,
        transactionTime: transaction.transaction_time || '00:00:00',
        type: transaction.type,
        categoryId: transaction.category_id,
        categoryName: transaction.category_name,
        paymentType: transaction.payment_type,
        chequeNumber: transaction.cheque_number,
        amount: formatAmount(transaction.amount),
        balance: formatAmount(transaction.balance),
        remarks: transaction.remarks || null,
        balanceCellBgColor: getBalanceCellBgColorByRemarks(transaction.remarks),
        createdBy: transaction.created_by,
        createdByUsername: transaction.created_by_username,
        createdAt: transaction.created_at
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch transaction'
    });
  }
});

// Create a new transaction
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      date,
      transactionTime,
      type,
      categoryId,
      paymentType,
      chequeNumber,
      amount,
      remarks
    } = req.body;

    // Validation
    if (!date || !type || !paymentType || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Date, type, paymentType, and amount are required'
      });
    }

    if (type !== 'Debit' && type !== 'Credit') {
      return res.status(400).json({
        success: false,
        error: 'Type must be either "Debit" or "Credit"'
      });
    }

    // Validate payment type
    const validPaymentTypes = ['cash', 'cheque', 'creditcard', 'online', 'dd'];
    if (!validPaymentTypes.includes(paymentType.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Payment type must be one of: ${validPaymentTypes.join(', ')}`
      });
    }

    if (paymentType.toLowerCase() === 'cheque' && !chequeNumber) {
      return res.status(400).json({
        success: false,
        error: 'Cheque number is required when payment type is cheque'
      });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be greater than 0'
      });
    }

    // Round amount to 2 decimal places before saving
    const roundedAmount = roundToTwoDecimals(parsedAmount);

    // Convert date format if needed (DD/MM/YYYY to YYYY-MM-DD)
    let formattedDate = date;
    if (date.includes('/')) {
      const [day, month, year] = date.split('/');
      formattedDate = `${year}-${month}-${day}`;
    }

    const normalizedTransactionTime = normalizeTransactionTimeInput(transactionTime);
    if (!normalizedTransactionTime) {
      return res.status(400).json({
        success: false,
        error: 'transactionTime must be in HH:mm or HH:mm:ss format'
      });
    }

    // Get user ID from JWT token (req.user is set by authenticateToken middleware)
    const createdBy = req.user ? req.user.id : null;

    const transaction = await Transaction.create({
      date: formattedDate,
      transactionTime: normalizedTransactionTime,
      type: type,
      categoryId: categoryId ? parseInt(categoryId) : null,
      paymentType: paymentType.toLowerCase(),
      chequeNumber: chequeNumber || null,
      amount: roundedAmount,
      remarks: remarks || null,
      createdBy: createdBy
    });

    res.status(201).json({
      success: true,
      message: 'Transaction created successfully',
      data: formatCreatedTransactionRow(transaction)
    });
  } catch (error) {
    console.error('Error creating transaction:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create transaction'
    });
  }
});

// Update a transaction
router.put(
  '/:id',
  authenticateToken,
  async (req, res) => {
  if (req.user && req.user.role === USER_ROLES.USER) {
    return queueTransactionPut(req, res);
  }
  try {
    const { id } = req.params;
    const pdcDueMatch = PDC_DUE_ID_RE.exec(String(id || '').trim());
    if (pdcDueMatch) {
      const pdcId = parseInt(pdcDueMatch[1], 10);
      const existingPdc = await PDC.getById(pdcId);
      if (!existingPdc) {
        return res.status(404).json({
          success: false,
          error: 'Post-dated cheque not found'
        });
      }

      const validChequeTypes = ['Payment Cheque', 'Security Cheque', 'Other'];
      const validPDCTypes = ['GCEC PDC', 'Customer PDC', 'Custom PDC'];
      const body = req.body || {};
      const inputDate = body.chequeDate ?? body.cheque_date ?? body.date ?? existingPdc.cheque_date;
      const amountRaw =
        body.amount != null && body.amount !== ''
          ? body.amount
          : body.debit != null && body.debit !== ''
            ? body.debit
            : body.credit != null && body.credit !== ''
              ? body.credit
              : existingPdc.amount;
      const chequeNumber = body.chequeNumber ?? body.cheque_number ?? existingPdc.cheque_number;
      const customerName =
        body.customerName ??
        body.customer_name ??
        body.customer ??
        body.category ??
        existingPdc.customer_name;
      const chequeType = body.chequeType ?? body.cheque_type ?? existingPdc.cheque_type;
      const pdcType = body.pdcType ?? body.pdc_type ?? existingPdc.pdc_type;
      const descriptionInput =
        hasOwn(body, 'description')
          ? body.description
          : hasOwn(body, 'description_text')
            ? body.description_text
            : hasOwn(body, 'remarks')
              ? body.remarks
              : existingPdc.description;
      const description = normalizePdcDescriptionInput(descriptionInput, pdcType);

      if (!inputDate || !chequeNumber || !customerName || amountRaw == null || !chequeType || !pdcType) {
        return res.status(400).json({
          success: false,
          error: 'Date, cheque number, customer name, amount, cheque type, and PDC type are required for PDC daily rows'
        });
      }
      if (!validChequeTypes.includes(String(chequeType))) {
        return res.status(400).json({
          success: false,
          error: `Cheque type must be one of: ${validChequeTypes.join(', ')}`
        });
      }
      if (!validPDCTypes.includes(String(pdcType))) {
        return res.status(400).json({
          success: false,
          error: `PDC type must be one of: ${validPDCTypes.join(', ')}`
        });
      }

      const parsedAmount = parseLooseAmount(amountRaw);
      if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Amount must be greater than 0'
        });
      }

      let formattedDate = String(inputDate);
      if (formattedDate.includes('/')) {
        const [day, month, year] = formattedDate.split('/');
        formattedDate = `${year}-${month}-${day}`;
      }

      if (pdcType === 'Custom PDC' && (!description || String(description).trim() === '')) {
        return res.status(400).json({
          success: false,
          error: 'Description is required for Custom PDC'
        });
      }

      const updatedPdc = await PDC.update(pdcId, {
        chequeDate: formattedDate,
        chequeNumber: String(chequeNumber).trim(),
        customerName: String(customerName).trim(),
        amount: roundToTwoDecimals(parsedAmount),
        chequeType: String(chequeType),
        pdcType: String(pdcType),
        description: description ? String(description).trim() : null
      });
      if (!updatedPdc) {
        return res.status(404).json({
          success: false,
          error: 'Post-dated cheque not found'
        });
      }

      const todayYmd = toYmd(new Date());
      const isCustomerPdc = isCustomerPdcType(updatedPdc.pdc_type);
      const isGcec = isGcecPdcType(updatedPdc.pdc_type);
      const isCredit = (isGcec && updatedPdc.cheque_date > todayYmd) || isCustomerPdc;

      return res.json({
        success: true,
        message: 'Daily transition PDC updated successfully',
        data: {
          id: `pdc-due-${updatedPdc.id}`,
          pdcId: updatedPdc.id,
          date: updatedPdc.cheque_date,
          category: updatedPdc.customer_name || '-',
          paymentType: 'cheque',
          chequeNumber: updatedPdc.cheque_number || '-',
          debit: isCredit ? null : formatAmount(updatedPdc.amount),
          credit: isCredit ? formatAmount(updatedPdc.amount) : null,
          remarks: buildPdcRemarks(updatedPdc.pdc_type, updatedPdc.description, {
            hideTypeFallback: isCustomerPdc && parseDailyLedgerApproved(updatedPdc.daily_ledger_approved)
          }),
          pdcType: updatedPdc.pdc_type
        }
      });
    }

    const {
      date,
      transactionTime,
      type,
      categoryId,
      paymentType,
      chequeNumber,
      amount,
      remarks
    } = req.body;

    // Validation
    if (!date || !type || !paymentType || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Date, type, paymentType, and amount are required'
      });
    }

    if (type !== 'Debit' && type !== 'Credit') {
      return res.status(400).json({
        success: false,
        error: 'Type must be either "Debit" or "Credit"'
      });
    }

    // Validate payment type
    const validPaymentTypes = ['cash', 'cheque', 'creditcard', 'online', 'dd'];
    if (!validPaymentTypes.includes(paymentType.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Payment type must be one of: ${validPaymentTypes.join(', ')}`
      });
    }

    if (paymentType.toLowerCase() === 'cheque' && !chequeNumber) {
      return res.status(400).json({
        success: false,
        error: 'Cheque number is required when payment type is cheque'
      });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be greater than 0'
      });
    }

    // Round amount to 2 decimal places before saving
    const roundedAmount = roundToTwoDecimals(parsedAmount);

    // Convert date format if needed (DD/MM/YYYY to YYYY-MM-DD)
    let formattedDate = date;
    if (date.includes('/')) {
      const [day, month, year] = date.split('/');
      formattedDate = `${year}-${month}-${day}`;
    }

    const normalizedTransactionTime = normalizeTransactionTimeInput(transactionTime);
    if (!normalizedTransactionTime) {
      return res.status(400).json({
        success: false,
        error: 'transactionTime must be in HH:mm or HH:mm:ss format'
      });
    }

    const transaction = await Transaction.update(id, {
      date: formattedDate,
      transactionTime: normalizedTransactionTime,
      type: type,
      categoryId: categoryId ? parseInt(categoryId) : null,
      paymentType: paymentType.toLowerCase(),
      chequeNumber: chequeNumber || null,
      amount: roundedAmount,
      remarks: remarks || null
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      message: 'Transaction updated successfully',
      data: {
        id: transaction.id,
        date: transaction.date,
        transactionTime: transaction.transaction_time || '00:00:00',
        category: transaction.category_name || '-',
        paymentType: transaction.payment_type,
        chequeNumber: transaction.cheque_number || '-',
        debit: transaction.type === 'Debit' ? formatAmount(transaction.amount) : null,
        credit: transaction.type === 'Credit' ? formatAmount(transaction.amount) : null,
        balance: formatAmount(transaction.balance),
        remarks: transaction.remarks || null,
        balanceCellBgColor: getBalanceCellBgColorByRemarks(transaction.remarks),
        createdBy: transaction.created_by,
        createdByUsername: transaction.created_by_username,
        createdAt: transaction.created_at
      }
    });
  } catch (error) {
    console.error('Error updating transaction:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update transaction'
    });
  }
});

// Delete a transaction
router.delete(
  '/:id',
  authenticateToken,
  async (req, res) => {
  if (req.user && req.user.role === USER_ROLES.USER) {
    return queueTransactionDelete(req, res);
  }
  try {
    const { id } = req.params;
    const pdcDueMatch = PDC_DUE_ID_RE.exec(String(id || '').trim());
    if (pdcDueMatch) {
      const pdcId = parseInt(pdcDueMatch[1], 10);
      const deletedPdc = await PDC.delete(pdcId);
      if (!deletedPdc) {
        return res.status(404).json({
          success: false,
          error: 'Post-dated cheque not found'
        });
      }
      return res.json({
        success: true,
        message: 'Post-dated cheque deleted successfully'
      });
    }

    const deleted = await Transaction.delete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      message: 'Transaction deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting transaction:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete transaction'
    });
  }
});

// Recalculate all balances (useful for fixing incorrect balances)
router.post(
  '/recalculate-balances',
  authenticateToken,
  requireElevatedForMutation,
  async (req, res) => {
  try {
    const finalBalance = await Transaction.recalculateAllBalances();
    
    res.json({
      success: true,
      message: 'All balances recalculated successfully',
      finalBalance: formatAmount(finalBalance)
    });
  } catch (error) {
    console.error('Error recalculating balances:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to recalculate balances'
    });
  }
});

module.exports = router;

