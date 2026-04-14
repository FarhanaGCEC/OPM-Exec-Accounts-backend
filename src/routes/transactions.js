const express = require('express');
const Transaction = require('../models/Transaction');
const { authenticateToken } = require('../middleware/auth');
const { requireElevatedForMutation } = require('../middleware/requireElevatedForMutation');
const { USER_ROLES } = require('../constants/roles');
const {
  queueTransactionDelete,
  queueTransactionPut,
} = require('../controllers/transactionChangeRequestQueue');
const { formatAmount, roundToTwoDecimals } = require('../utils/formatAmount');
const { pool } = require('../config/database');
const {
  isGcecPdcType,
  isCustomerPdcType,
  parseDailyLedgerApproved
} = require('../utils/pdcLedgerApproval');
const PDC = require('../models/PDC');
const PurchaseBill = require('../models/PurchaseBill');

const router = express.Router();

const PDC_DUE_ID_RE = /^pdc-due-(\d+)$/i;

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

/**
 * Post-dated cheques that have matured (cheque_date <= today) — shown as Daily Transaction rows.
 * Optional startDate/endDate filter on cheque_date (for /all); omit for full history on GET /.
 */
async function fetchPdcRowsMaturedForDailyLedger({ startDate, endDate } = {}) {
  const conditions = [
    'pdc.cheque_date <= CURDATE()',
    "pdc.pdc_type IN ('GCEC PDC', 'Customer PDC', 'Custom PDC')"
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
  const isCredit = isCustomerPdcType(pdc.pdc_type);
  const rowDate = pdc.cheque_date_ymd || toYmd(pdc.cheque_date);
  const remarks =
    pdc.description && String(pdc.description).trim()
      ? `${pdc.pdc_type}, ${String(pdc.description).trim()}`
      : pdc.pdc_type;
  const ledgerApprovalRequired = isGcecPdcType(pdc.pdc_type);
  const ledgerApproved = ledgerApprovalRequired
    ? parseDailyLedgerApproved(pdc.daily_ledger_approved)
    : true;
  const base = {
    id: `pdc-due-${pdc.id}`,
    date: rowDate,
    category: pdc.customer_name || '-',
    paymentType: 'cheque',
    chequeNumber: pdc.cheque_number || '-',
    debit: isCredit ? null : formatAmount(pdc.amount),
    credit: isCredit ? formatAmount(pdc.amount) : null,
    balance: null,
    remarks,
    createdBy: pdc.created_by,
    createdByUsername: pdc.created_by_username || null,
    createdAt: pdc.created_at,
    pdcId: pdc.id,
    pdcType: pdc.pdc_type,
    syntheticFromPdc: true,
    ledgerApprovalRequired,
    ledgerApproved,
    showLedgerApprovalCheckbox: ledgerApprovalRequired && !ledgerApproved,
    /** Explicit flag for UI — use this or showLedgerApprovalCheckbox (do not rely on remarks text alone) */
    pendingGcecLedgerApproval: ledgerApprovalRequired && !ledgerApproved,
    /** When true, UI may clone this row at table end (no date on clone); backend sends this row once only */
    ledgerApprovalFooterDuplicateForUi: ledgerApprovalRequired && !ledgerApproved
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
    const ida = typeof a.id === 'number' ? a.id : Number.MAX_SAFE_INTEGER;
    const idb = typeof b.id === 'number' ? b.id : Number.MAX_SAFE_INTEGER;
    if (ida !== idb) return ida - idb;
    return String(a.id).localeCompare(String(b.id));
  });
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
      ORDER BY t.date ASC, t.id ASC
    `;
    const transactionsResult = await pool.query(transactionsQuery, txnDateFilter.params);
    let dailyTransactions = transactionsResult.rows.map(txn => ({
      id: txn.id,
      date: txn.date,
      transactionType: 'Daily Transaction',
      category: txn.category_name || '-',
      paymentType: txn.payment_type,
      chequeNumber: txn.cheque_number || '-',
      debit: txn.type === 'Debit' ? formatAmount(txn.amount) : null,
      credit: txn.type === 'Credit' ? formatAmount(txn.amount) : null,
      balance: formatAmount(txn.balance),
      remarks: txn.remarks || null,
      createdBy: txn.created_by,
      createdByUsername: txn.created_by_username || null,
      createdAt: txn.created_at
    }));

    // PDCs whose cheque date has arrived: Daily Transaction rows dated as cheque_date (same range as filters when set)
    const pdcRows = await fetchPdcRowsMaturedForDailyLedger({ startDate, endDate });
    const pdcAsDaily = pdcRows.map((pdc) =>
      mapPdcMaturedToSyntheticRow(pdc, { transactionType: 'Daily Transaction' })
    );
    dailyTransactions = sortMergedByDateThenId([...dailyTransactions, ...pdcAsDaily]);
    await applyRunningBalancesToMainRows(dailyTransactions);

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
        pdc.description,
        pdc.created_by,
        u.username as created_by_username,
        pdc.created_at,
        'Customer PDC' as transaction_type
      FROM post_dated_cheques pdc
      LEFT JOIN users u ON pdc.created_by = u.id
      WHERE pdc.pdc_type = 'Customer PDC'
        AND pdc.cheque_date > CURDATE()
      ${customerPdcDateFilter.whereClause ? `AND ${customerPdcDateFilter.whereClause}` : ''}
      ORDER BY pdc.cheque_date ASC, pdc.created_at ASC
    `;
    const customerPdcResult = await pool.query(customerPdcQuery, customerPdcDateFilter.params);
    const customerPdcs = customerPdcResult.rows.map(pdc => ({
      id: pdc.id,
      date: pdc.date,
      transactionType: 'Customer PDC',
      customerName: pdc.customer_name,
      chequeNumber: pdc.cheque_number,
      chequeType: pdc.cheque_type,
      amount: formatAmount(pdc.amount),
      description: pdc.description || null,
      createdBy: pdc.created_by,
      createdByUsername: pdc.created_by_username || null,
      createdAt: pdc.created_at
    }));

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

    res.json({
      success: true,
      data: allTransactions,
      summary: {
        dailyTransactions: dailyTransactions.length,
        gcecPdc: gcecPdcs.length,
        customerPdc: customerPdcs.length,
        purchaseBills: purchaseBills.length,
        total: allTransactions.length
      },
      filters: {
        startDate: startDate || null,
        endDate: endDate || null
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
      category: txn.category_name || '-',
      paymentType: txn.payment_type,
      chequeNumber: txn.cheque_number || '-',
      debit: txn.type === 'Debit' ? formatAmount(txn.amount) : null,
      credit: txn.type === 'Credit' ? formatAmount(txn.amount) : null,
      balance: formatAmount(txn.balance),
      remarks: txn.remarks || null,
      createdBy: txn.created_by,
      createdByUsername: txn.created_by_username || null,
      createdAt: txn.created_at
    }));

    const pdcRows = await fetchPdcRowsMaturedForDailyLedger({});
    const synthetic = pdcRows.map((pdc) => mapPdcMaturedToSyntheticRow(pdc));
    formattedTransactions = sortMergedByDateThenId([...formattedTransactions, ...synthetic]);
    await applyRunningBalancesToMainRows(formattedTransactions);

    const currentBalance =
      formattedTransactions.length > 0 ? formattedTransactions[formattedTransactions.length - 1].balance : '0.00';

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

function formatCreatedTransactionRow(transaction) {
  return {
    id: transaction.id,
    date: transaction.date,
    category: transaction.category_name || '-',
    paymentType: transaction.payment_type,
    chequeNumber: transaction.cheque_number || '-',
    debit: transaction.type === 'Debit' ? formatAmount(transaction.amount) : null,
    credit: transaction.type === 'Credit' ? formatAmount(transaction.amount) : null,
    balance: formatAmount(transaction.balance),
    remarks: transaction.remarks || null,
    createdBy: transaction.created_by,
    createdByUsername: transaction.created_by_username,
    createdAt: transaction.created_at
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
        paymentType,
        chequeNumber,
        amount,
        remarks
      } = row || {};

      if (!date || !type || !paymentType || amount == null) {
        errors.push({
          index: i,
          error: 'Date, type, paymentType, and amount are required'
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

      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        errors.push({
          index: i,
          error: 'Amount must be greater than 0'
        });
        continue;
      }

      let parsedCategoryId = null;
      if (categoryId != null && categoryId !== '') {
        parsedCategoryId = parseInt(categoryId, 10);
        if (!Number.isFinite(parsedCategoryId)) {
          errors.push({
            index: i,
            error: 'categoryId must be a number when provided'
          });
          continue;
        }
      }

      const formattedDate = normalizeTransactionDateInput(date);
      normalized.push({
        date: formattedDate,
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
    const created = await Transaction.createMany(normalized, createdBy);

    res.status(201).json({
      success: true,
      message: `${created.length} transaction(s) created successfully`,
      created: created.length,
      data: created.map(formatCreatedTransactionRow)
    });
  } catch (error) {
    console.error('Error bulk creating transactions:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to bulk create transactions'
    });
  }
});

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

      // missingIds: same as older API (ledger rows not found)
      res.json({
        success: true,
        message: `${deleted} row(s) deleted (${deletedLedger} ledger, ${deletedPdc} PDC, ${deletedPurchaseBills} purchase bill)`,
        deleted,
        deletedLedger,
        deletedPdc,
        deletedPurchaseBills,
        missingLedgerIds,
        missingPdcIds,
        missingPurchaseBillIds,
        missingIds: missingLedgerIds
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
        type: transaction.type,
        categoryId: transaction.category_id,
        categoryName: transaction.category_name,
        paymentType: transaction.payment_type,
        chequeNumber: transaction.cheque_number,
        amount: formatAmount(transaction.amount),
        balance: formatAmount(transaction.balance),
        remarks: transaction.remarks || null,
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
    const { date, type, categoryId, paymentType, chequeNumber, amount, remarks } = req.body;

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

    // Get user ID from JWT token (req.user is set by authenticateToken middleware)
    const createdBy = req.user ? req.user.id : null;

    const transaction = await Transaction.create({
      date: formattedDate,
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
    const { date, type, categoryId, paymentType, chequeNumber, amount, remarks } = req.body;

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

    const transaction = await Transaction.update(id, {
      date: formattedDate,
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
        category: transaction.category_name || '-',
        paymentType: transaction.payment_type,
        chequeNumber: transaction.cheque_number || '-',
        debit: transaction.type === 'Debit' ? formatAmount(transaction.amount) : null,
        credit: transaction.type === 'Credit' ? formatAmount(transaction.amount) : null,
        balance: formatAmount(transaction.balance),
        remarks: transaction.remarks || null,
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

