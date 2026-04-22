const express = require('express');
const EmiratesTransaction = require('../models/EmiratesTransaction');
const { authenticateToken } = require('../middleware/auth');
const { requireElevatedForMutation } = require('../middleware/requireElevatedForMutation');
const { formatAmount, roundToTwoDecimals, parseLooseAmount } = require('../utils/formatAmount');
const { parseBankLedgerBulkCsvBuffer } = require('../utils/parseBankLedgerBulkCsv');
const { uploadBankLedgerCsv } = require('../middleware/bankLedgerCsvUpload');
const { pool } = require('../config/database');

const router = express.Router();
const VALID_CURRENCIES = ['AED', 'USD', 'GBP'];

function normalizeCurrencyOrNull(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toUpperCase();
  return normalized || null;
}

function validateCurrencyOrSend(res, currency) {
  if (!currency) return { valid: true, currency: null };
  if (!VALID_CURRENCIES.includes(currency)) {
    res.status(400).json({
      success: false,
      error: `Currency must be one of: ${VALID_CURRENCIES.join(', ')}`
    });
    return { valid: false, currency: null };
  }
  return { valid: true, currency };
}

const MAX_BULK_EMIRATES = 500;

function bulkWantFullRowPayload(req) {
  const q = req.query || {};
  return (
    q.full === '1' ||
    q.full === 'true' ||
    q.details === '1' ||
    String(req.headers['x-bulk-full-response'] || '') === '1'
  );
}

function formatEmiratesCreatedRow(transaction) {
  if (!transaction) return null;
  return {
    id: transaction.id,
    accountNumber: transaction.account_number || null,
    date: transaction.date,
    description: transaction.description,
    details: transaction.details || null,
    currency: transaction.currency || 'AED',
    debit: formatAmount(transaction.debit || 0),
    bankCharges: formatAmount(transaction.bank_charges || 0),
    credit: formatAmount(transaction.credit || 0),
    balance: formatAmount(transaction.balance),
    createdBy: transaction.created_by,
    createdByUsername: transaction.created_by_username || null,
    createdAt: transaction.created_at
  };
}

/** Normalize date to YYYY-MM-DD (same rules as POST /). */
function normalizeEmiratesDateInput(date) {
  if (date instanceof Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  if (typeof date === 'string') {
    if (date.includes('/')) {
      const [day, month, year] = date.split('/');
      return `${year}-${month}-${day}`;
    }
    return date;
  }
  return date;
}

// Get all Emirates transactions
router.get('/', authenticateToken, async (req, res) => {
  try {
    const requestedCurrency = normalizeCurrencyOrNull(req.query.currency);
    const currencyValidation = validateCurrencyOrSend(res, requestedCurrency);
    if (!currencyValidation.valid) return;
    const transactions = await EmiratesTransaction.getAll(currencyValidation.currency);

    // Format response
    const formattedTransactions = transactions.map(txn => ({
      id: txn.id,
      accountNumber: txn.account_number || null,
      date: txn.date,
      description: txn.description,
      details: txn.details || null,
      currency: txn.currency || 'AED',
      debit: formatAmount(txn.debit || 0),
      bankCharges: formatAmount(txn.bank_charges || 0),
      credit: formatAmount(txn.credit || 0),
      balance: formatAmount(txn.balance),
      createdBy: txn.created_by,
      createdByUsername: txn.created_by_username || null,
      createdAt: txn.created_at,
      updatedAt: txn.updated_at
    }));

    const responsePayload = {
      success: true,
      data: formattedTransactions,
      totalTransactions: transactions.length
    };

    // If currency is specified, return that currency's latest balance.
    if (currencyValidation.currency) {
      const latestBalance = await EmiratesTransaction.getLatestBalance(currencyValidation.currency);
      responsePayload.currency = currencyValidation.currency;
      responsePayload.currentBalance = formatAmount(latestBalance);
    } else {
      // No filter: expose balances per currency so tabs can stay isolated.
      const balances = await Promise.all(
        VALID_CURRENCIES.map(async (currency) => ({
          currency,
          balance: formatAmount(await EmiratesTransaction.getLatestBalance(currency))
        }))
      );
      responsePayload.currentBalanceByCurrency = balances.reduce((acc, item) => {
        acc[item.currency] = item.balance;
        return acc;
      }, {});
    }

    res.json(responsePayload);
  } catch (error) {
    console.error('Error fetching Emirates transactions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch Emirates transactions'
    });
  }
});

// Get bank balance (current balance) for a specific currency
router.get('/balance', authenticateToken, async (req, res) => {
  try {
    const requestedCurrency = normalizeCurrencyOrNull(req.query.currency) || 'AED';
    const currencyValidation = validateCurrencyOrSend(res, requestedCurrency);
    if (!currencyValidation.valid) return;
    const transactionCurrency = currencyValidation.currency;

    const balance = await EmiratesTransaction.getLatestBalance(transactionCurrency);

    res.json({
      success: true,
      currency: transactionCurrency,
      balance: formatAmount(balance)
    });
  } catch (error) {
    console.error('Error fetching bank balance:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch bank balance'
    });
  }
});

/**
 * Bulk create FK Emirates NBD rows. Body: { transactions: [ same fields as POST / ] }
 * Rows are applied in chronological order (by date, then array order for the same date).
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

    if (raw.length > MAX_BULK_EMIRATES) {
      return res.status(400).json({
        success: false,
        error: `At most ${MAX_BULK_EMIRATES} transactions per request`
      });
    }

    const validCurrencies = ['AED', 'USD', 'GBP'];
    const errors = [];
    const normalized = [];

    for (let i = 0; i < raw.length; i++) {
      const row = raw[i] || {};
      const {
        account_number,
        accountNumber: accountNumberCamel,
        date,
        description,
        details,
        currency: currencyRaw,
        debit,
        bank_charges,
        bankCharges: bankChargesCamel,
        credit
      } = row;

      if (!date || !description) {
        errors.push({ index: i, error: 'Date and description are required' });
        continue;
      }

      const transactionCurrency = String(currencyRaw || 'AED').toUpperCase();
      if (!validCurrencies.includes(transactionCurrency)) {
        errors.push({
          index: i,
          error: `Currency must be one of: ${validCurrencies.join(', ')}`
        });
        continue;
      }

      const parsedDebit = parseLooseAmount(debit ?? 0);
      const parsedBankCharges = parseLooseAmount(
        bank_charges ?? bankChargesCamel ?? 0
      );
      const parsedCredit = parseLooseAmount(credit ?? 0);

      if (!Number.isFinite(parsedDebit) || parsedDebit < 0) {
        errors.push({
          index: i,
          error: 'Debit must be a valid number >= 0'
        });
        continue;
      }
      if (!Number.isFinite(parsedBankCharges) || parsedBankCharges < 0) {
        errors.push({
          index: i,
          error: 'Bank charges must be a valid number >= 0'
        });
        continue;
      }
      if (!Number.isFinite(parsedCredit) || parsedCredit < 0) {
        errors.push({
          index: i,
          error: 'Credit must be a valid number >= 0'
        });
        continue;
      }

      const hasDebit = parsedDebit > 0;
      const hasBankCharges = parsedBankCharges > 0;
      const hasCredit = parsedCredit > 0;
      if (!hasDebit && !hasBankCharges && !hasCredit) {
        errors.push({
          index: i,
          error:
            'At least one of debit, bank_charges, or credit must be greater than 0'
        });
        continue;
      }

      const acct = account_number ?? accountNumberCamel;
      normalized.push({
        _batchIndex: i,
        accountNumber: acct != null && String(acct).trim() !== '' ? String(acct).trim() : null,
        date: normalizeEmiratesDateInput(date),
        description: String(description).trim(),
        details: details != null && String(details).trim() !== '' ? String(details).trim() : null,
        currency: transactionCurrency,
        debit: roundToTwoDecimals(parsedDebit),
        bankCharges: roundToTwoDecimals(parsedBankCharges),
        credit: roundToTwoDecimals(parsedCredit)
      });
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed for one or more rows',
        errors
      });
    }

    normalized.sort((a, b) => {
      if (a.date < b.date) return -1;
      if (a.date > b.date) return 1;
      return a._batchIndex - b._batchIndex;
    });

    const createdBy = req.user ? req.user.id : null;
    const wantFull = bulkWantFullRowPayload(req);
    const insertedIds = [];
    const data = [];

    for (const n of normalized) {
      const transaction = await EmiratesTransaction.create({
        accountNumber: n.accountNumber,
        date: n.date,
        description: n.description,
        details: n.details,
        currency: n.currency,
        debit: n.debit,
        bankCharges: n.bankCharges,
        credit: n.credit,
        createdBy
      });
      insertedIds.push(transaction.id);
      if (wantFull) {
        data.push(formatEmiratesCreatedRow(transaction));
      }
    }

    if (!wantFull) {
      res.status(200).json({
        success: true,
        message: `${insertedIds.length} Emirates transaction(s) created`,
        created: insertedIds.length,
        insertedIds,
        hint: 'Pass ?full=1 to include formatted row objects in "data".'
      });
    } else {
      res.status(200).json({
        success: true,
        message: `${insertedIds.length} Emirates transaction(s) created`,
        created: insertedIds.length,
        insertedIds,
        data
      });
    }
  } catch (error) {
    console.error('Error bulk creating Emirates transactions:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to bulk create Emirates transactions'
    });
  }
});

/**
 * Bulk import from bank-style CSV (Date, Description, Details, Debit, Credit).
 * Optional query: account_number, currency (default AED). Multipart field name: file
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

      if (parsedRows.length > MAX_BULK_EMIRATES) {
        return res.status(400).json({
          success: false,
          error: `At most ${MAX_BULK_EMIRATES} transactions per file`
        });
      }

      const validCurrencies = ['AED', 'USD', 'GBP'];
      const qCurrency = (req.query.currency || 'AED').toUpperCase();
      if (!validCurrencies.includes(qCurrency)) {
        return res.status(400).json({
          success: false,
          error: `currency query must be one of: ${validCurrencies.join(', ')}`
        });
      }

      const accountNumber =
        req.query.account_number != null && String(req.query.account_number).trim() !== ''
          ? String(req.query.account_number).trim()
          : null;

      const sorted = [...parsedRows].sort((a, b) => {
        if (a.date < b.date) return -1;
        if (a.date > b.date) return 1;
        return 0;
      });

      const createdBy = req.user ? req.user.id : null;
      const wantFull = bulkWantFullRowPayload(req);
      const insertedIds = [];
      const data = [];

      for (const pr of sorted) {
        const debit = pr.type === 'Debit' ? roundToTwoDecimals(pr.amount) : 0;
        const credit = pr.type === 'Credit' ? roundToTwoDecimals(pr.amount) : 0;
        const transaction = await EmiratesTransaction.create({
          accountNumber,
          date: pr.date,
          description: pr.description,
          details: pr.details || null,
          currency: qCurrency,
          debit,
          bankCharges: 0,
          credit,
          createdBy
        });
        insertedIds.push(transaction.id);
        if (wantFull) {
          data.push(formatEmiratesCreatedRow(transaction));
        }
      }

      if (!wantFull) {
        res.status(200).json({
          success: true,
          message: `${insertedIds.length} Emirates transaction(s) imported from CSV`,
          created: insertedIds.length,
          insertedIds,
          hint: 'Pass ?full=1 to include formatted row objects in "data".'
        });
      } else {
        res.status(200).json({
          success: true,
          message: `${insertedIds.length} Emirates transaction(s) imported from CSV`,
          created: insertedIds.length,
          insertedIds,
          data
        });
      }
    } catch (error) {
      console.error('Emirates bulk CSV error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to import Emirates transactions from CSV'
      });
    }
  }
);

/**
 * Bulk delete by numeric ids (admin / accountant). Deletes in reverse chronological order
 * so running balances stay consistent.
 */
router.post(
  '/bulk-delete',
  authenticateToken,
  requireElevatedForMutation,
  async (req, res) => {
    try {
      const idsRaw = req.body && Array.isArray(req.body.ids) ? req.body.ids : null;

      if (!idsRaw) {
        return res.status(400).json({
          success: false,
          error: 'Request body must include an "ids" array of Emirates transaction ids'
        });
      }

      if (idsRaw.length === 0) {
        return res.status(400).json({
          success: false,
          error: '"ids" must not be empty'
        });
      }

      const unique = [...new Set(idsRaw.map((x) => parseInt(x, 10)))].filter(
        (n) => Number.isInteger(n) && n > 0
      );

      const invalid = [];
      for (let i = 0; i < idsRaw.length; i++) {
        const n = parseInt(idsRaw[i], 10);
        if (!Number.isInteger(n) || n <= 0) {
          invalid.push({ index: i, value: idsRaw[i], error: 'Must be a positive integer' });
        }
      }

      if (invalid.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed for one or more ids',
          invalid
        });
      }

      if (unique.length > MAX_BULK_EMIRATES) {
        return res.status(400).json({
          success: false,
          error: `At most ${MAX_BULK_EMIRATES} distinct ids per request`
        });
      }

      if (unique.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No valid ids to delete'
        });
      }

      const placeholders = unique.map(() => '?').join(',');
      const orderResult = await pool.query(
        `SELECT id FROM emirates_transactions WHERE id IN (${placeholders}) ORDER BY date DESC, id DESC`,
        unique
      );

      const foundSet = new Set(orderResult.rows.map((r) => r.id));
      const missingIds = unique.filter((id) => !foundSet.has(id));

      let deleted = 0;
      for (const row of orderResult.rows) {
        const ok = await EmiratesTransaction.delete(row.id);
        if (ok) deleted += 1;
      }

      if (deleted === 0) {
        return res.status(200).json({
          success: false,
          error:
            'No rows were deleted. Ids may be wrong or rows may already be removed.',
          deleted: 0,
          missingIds: missingIds.length > 0 ? missingIds : unique
        });
      }

      const partial = missingIds.length > 0;
      res.status(200).json({
        success: true,
        ...(partial
          ? {
              partial: true,
              warning: 'Some ids were not found (already deleted or invalid).'
            }
          : {}),
        message: `${deleted} Emirates transaction(s) deleted`,
        deleted,
        missingIds
      });
    } catch (error) {
      console.error('Error bulk deleting Emirates transactions:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to bulk delete Emirates transactions'
      });
    }
  }
);

// Get a single Emirates transaction by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const transaction = await EmiratesTransaction.getById(id);

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Emirates transaction not found'
      });
    }

    res.json({
      success: true,
      data: {
        id: transaction.id,
        accountNumber: transaction.account_number || null,
        date: transaction.date,
        description: transaction.description,
        details: transaction.details || null,
        currency: transaction.currency || 'AED',
        debit: formatAmount(transaction.debit || 0),
        bankCharges: formatAmount(transaction.bank_charges || 0),
        credit: formatAmount(transaction.credit || 0),
        balance: formatAmount(transaction.balance),
        createdBy: transaction.created_by,
        createdByUsername: transaction.created_by_username,
        createdAt: transaction.created_at,
        updatedAt: transaction.updated_at
      }
    });
  } catch (error) {
    console.error('Error fetching Emirates transaction:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch Emirates transaction'
    });
  }
});

// Create a new Emirates transaction
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { 
      account_number, 
      date, 
      description, 
      details, 
      currency,
      debit, 
      bank_charges, 
      credit 
    } = req.body;

    // Validation
    if (!date || !description) {
      return res.status(400).json({
        success: false,
        error: 'Date and description are required'
      });
    }

    // Resolve/validate currency from body first, then query, then default AED
    const transactionCurrency =
      normalizeCurrencyOrNull(currency) ||
      normalizeCurrencyOrNull(req.query.currency) ||
      'AED';
    const currencyValidation = validateCurrencyOrSend(res, transactionCurrency);
    if (!currencyValidation.valid) return;

    // At least one of debit, bank_charges, or credit must be provided
    const hasDebit = debit !== undefined && debit !== null && parseFloat(debit) > 0;
    const hasBankCharges = bank_charges !== undefined && bank_charges !== null && parseFloat(bank_charges) > 0;
    const hasCredit = credit !== undefined && credit !== null && parseFloat(credit) > 0;

    if (!hasDebit && !hasBankCharges && !hasCredit) {
      return res.status(400).json({
        success: false,
        error: 'At least one of debit, bank_charges, or credit must be provided and greater than 0'
      });
    }

    // Validate amounts are non-negative
    const parsedDebit = parseFloat(debit || 0);
    const parsedBankCharges = parseFloat(bank_charges || 0);
    const parsedCredit = parseFloat(credit || 0);

    if (isNaN(parsedDebit) || parsedDebit < 0) {
      return res.status(400).json({
        success: false,
        error: 'Debit must be a valid number >= 0'
      });
    }

    if (isNaN(parsedBankCharges) || parsedBankCharges < 0) {
      return res.status(400).json({
        success: false,
        error: 'Bank charges must be a valid number >= 0'
      });
    }

    if (isNaN(parsedCredit) || parsedCredit < 0) {
      return res.status(400).json({
        success: false,
        error: 'Credit must be a valid number >= 0'
      });
    }

    // Convert date format if needed (DD/MM/YYYY to YYYY-MM-DD)
    let formattedDate = date;
    
    // Convert Date object to string if needed
    if (date instanceof Date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      formattedDate = `${year}-${month}-${day}`;
    } else if (typeof date === 'string') {
      // If it's already in YYYY-MM-DD format, use as is
      if (date.includes('/')) {
        const [day, month, year] = date.split('/');
        formattedDate = `${year}-${month}-${day}`;
      } else {
        // Already in YYYY-MM-DD format
        formattedDate = date;
      }
    }

    // Get user ID from JWT token
    const createdBy = req.user ? req.user.id : null;

    const transaction = await EmiratesTransaction.create({
      accountNumber: account_number || null,
      date: formattedDate,
      description: description,
      details: details || null,
      currency: currencyValidation.currency,
      debit: parsedDebit,
      bankCharges: parsedBankCharges,
      credit: parsedCredit,
      createdBy: createdBy
    });

    res.status(201).json({
      success: true,
      message: 'Emirates transaction created successfully',
      data: {
        id: transaction.id,
        accountNumber: transaction.account_number || null,
        date: transaction.date,
        description: transaction.description,
        details: transaction.details || null,
        currency: transaction.currency || 'AED',
        debit: formatAmount(transaction.debit || 0),
        bankCharges: formatAmount(transaction.bank_charges || 0),
        credit: formatAmount(transaction.credit || 0),
        balance: formatAmount(transaction.balance),
        createdBy: transaction.created_by,
        createdByUsername: transaction.created_by_username,
        createdAt: transaction.created_at
      }
    });
  } catch (error) {
    console.error('Error creating Emirates transaction:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create Emirates transaction'
    });
  }
});

// Update handler function (shared by PUT and PATCH)
const updateTransactionHandler = async (req, res, isPatch = false) => {
  try {
    const { id } = req.params;
    
    // For PATCH, get existing transaction first to merge with updates
    let existingTransaction = null;
    if (isPatch) {
      existingTransaction = await EmiratesTransaction.getById(id);
      if (!existingTransaction) {
        return res.status(404).json({
          success: false,
          error: 'Emirates transaction not found'
        });
      }
    }
    
    const { 
      account_number, 
      date, 
      description, 
      details, 
      currency,
      debit, 
      bank_charges, 
      credit 
    } = req.body;

    // For PATCH, merge with existing values
    const finalDate = date !== undefined ? date : (isPatch ? existingTransaction.date : null);
    const finalDescription = description !== undefined ? description : (isPatch ? existingTransaction.description : null);
    const finalDetails = details !== undefined ? details : (isPatch ? existingTransaction.details : null);
    const finalCurrency = currency !== undefined ? currency : (isPatch ? existingTransaction.currency : null);
    const finalDebit = debit !== undefined ? debit : (isPatch ? existingTransaction.debit : null);
    const finalBankCharges = bank_charges !== undefined ? bank_charges : (isPatch ? existingTransaction.bank_charges : null);
    const finalCredit = credit !== undefined ? credit : (isPatch ? existingTransaction.credit : null);
    const finalAccountNumber = account_number !== undefined ? account_number : (isPatch ? existingTransaction.account_number : null);

    // Validation
    if (!finalDate || !finalDescription) {
      return res.status(400).json({
        success: false,
        error: 'Date and description are required'
      });
    }

    // Resolve/validate currency with request scope support.
    const transactionCurrency =
      normalizeCurrencyOrNull(finalCurrency) ||
      normalizeCurrencyOrNull(req.query.currency) ||
      'AED';
    const currencyValidation = validateCurrencyOrSend(res, transactionCurrency);
    if (!currencyValidation.valid) return;

    // At least one of debit, bank_charges, or credit must be provided
    const hasDebit = finalDebit !== undefined && finalDebit !== null && parseFloat(finalDebit) > 0;
    const hasBankCharges = finalBankCharges !== undefined && finalBankCharges !== null && parseFloat(finalBankCharges) > 0;
    const hasCredit = finalCredit !== undefined && finalCredit !== null && parseFloat(finalCredit) > 0;

    if (!hasDebit && !hasBankCharges && !hasCredit) {
      return res.status(400).json({
        success: false,
        error: 'At least one of debit, bank_charges, or credit must be provided and greater than 0'
      });
    }

    // Validate amounts are non-negative
    const parsedDebit = parseFloat(finalDebit || 0);
    const parsedBankCharges = parseFloat(finalBankCharges || 0);
    const parsedCredit = parseFloat(finalCredit || 0);

    if (isNaN(parsedDebit) || parsedDebit < 0) {
      return res.status(400).json({
        success: false,
        error: 'Debit must be a valid number >= 0'
      });
    }

    if (isNaN(parsedBankCharges) || parsedBankCharges < 0) {
      return res.status(400).json({
        success: false,
        error: 'Bank charges must be a valid number >= 0'
      });
    }

    if (isNaN(parsedCredit) || parsedCredit < 0) {
      return res.status(400).json({
        success: false,
        error: 'Credit must be a valid number >= 0'
      });
    }

    // Convert date format if needed (DD/MM/YYYY to YYYY-MM-DD)
    let formattedDate = finalDate;
    
    // Convert Date object to string if needed
    if (finalDate instanceof Date) {
      const year = finalDate.getFullYear();
      const month = String(finalDate.getMonth() + 1).padStart(2, '0');
      const day = String(finalDate.getDate()).padStart(2, '0');
      formattedDate = `${year}-${month}-${day}`;
    } else if (typeof finalDate === 'string') {
      // If it's already in YYYY-MM-DD format, use as is
      if (finalDate.includes('/')) {
        const [day, month, year] = finalDate.split('/');
        formattedDate = `${year}-${month}-${day}`;
      } else {
        // Already in YYYY-MM-DD format
        formattedDate = finalDate;
      }
    }

    const transaction = await EmiratesTransaction.update(id, {
      accountNumber: finalAccountNumber || null,
      date: formattedDate,
      description: finalDescription,
      details: finalDetails || null,
      currency: currencyValidation.currency,
      debit: parsedDebit,
      bankCharges: parsedBankCharges,
      credit: parsedCredit
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Emirates transaction not found'
      });
    }

    res.json({
      success: true,
      message: 'Emirates transaction updated successfully',
      data: {
        id: transaction.id,
        accountNumber: transaction.account_number || null,
        date: transaction.date,
        description: transaction.description,
        details: transaction.details || null,
        currency: transaction.currency || 'AED',
        debit: formatAmount(transaction.debit || 0),
        bankCharges: formatAmount(transaction.bank_charges || 0),
        credit: formatAmount(transaction.credit || 0),
        balance: formatAmount(transaction.balance),
        createdBy: transaction.created_by,
        createdByUsername: transaction.created_by_username,
        createdAt: transaction.created_at,
        updatedAt: transaction.updated_at
      }
    });
  } catch (error) {
    console.error('Error updating Emirates transaction:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update Emirates transaction'
    });
  }
};

// Update a Emirates transaction (PUT - full update)
router.put('/:id', authenticateToken, requireElevatedForMutation, (req, res) =>
  updateTransactionHandler(req, res, false)
);

// Update a Emirates transaction (PATCH - partial update)
router.patch('/:id', authenticateToken, requireElevatedForMutation, (req, res) =>
  updateTransactionHandler(req, res, true)
);

// Delete a Emirates transaction
router.delete('/:id', authenticateToken, requireElevatedForMutation, async (req, res) => {
  try {
    const { id } = req.params;
    const scopedCurrency =
      normalizeCurrencyOrNull(req.query.currency) ||
      normalizeCurrencyOrNull(req.body && req.body.currency);
    const currencyValidation = validateCurrencyOrSend(res, scopedCurrency);
    if (!currencyValidation.valid) return;

    if (currencyValidation.currency) {
      const existing = await EmiratesTransaction.getById(id);
      if (!existing) {
        return res.status(404).json({
          success: false,
          error: 'Emirates transaction not found'
        });
      }
      if ((existing.currency || 'AED').toUpperCase() !== currencyValidation.currency) {
        return res.status(400).json({
          success: false,
          error: `Transaction does not belong to ${currencyValidation.currency}`
        });
      }
    }

    const deleted = await EmiratesTransaction.delete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Emirates transaction not found'
      });
    }

    res.json({
      success: true,
      message: 'Emirates transaction deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting Emirates transaction:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete Emirates transaction'
    });
  }
});

// Recalculate all balances (useful for fixing incorrect balances)
router.post('/recalculate-balances', authenticateToken, requireElevatedForMutation, async (req, res) => {
  try {
    const finalBalances = await EmiratesTransaction.recalculateAllBalances();
    
    const formattedBalances = {};
    for (const [currency, balance] of Object.entries(finalBalances)) {
      formattedBalances[currency] = formatAmount(balance);
    }
    
    res.json({
      success: true,
      message: 'All Emirates transaction balances recalculated successfully',
      finalBalances: formattedBalances
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
