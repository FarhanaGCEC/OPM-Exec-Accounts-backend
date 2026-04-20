const express = require('express');
const EmiratesTransaction = require('../models/EmiratesTransaction');
const { authenticateToken } = require('../middleware/auth');
const { requireElevatedForMutation } = require('../middleware/requireElevatedForMutation');
const { formatAmount } = require('../utils/formatAmount');

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

// Bulk create Emirates transactions (keeps each currency independent)
router.post('/bulk', authenticateToken, requireElevatedForMutation, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.transactions) ? req.body.transactions : [];
    if (rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'transactions array is required'
      });
    }

    const defaultCurrency = normalizeCurrencyOrNull(req.query.currency);
    const defaultCurrencyValidation = validateCurrencyOrSend(res, defaultCurrency);
    if (!defaultCurrencyValidation.valid) return;

    const createdRows = [];
    for (const row of rows) {
      const rowCurrency =
        normalizeCurrencyOrNull(row.currency) ||
        defaultCurrencyValidation.currency ||
        'AED';
      const rowCurrencyValidation = validateCurrencyOrSend(res, rowCurrency);
      if (!rowCurrencyValidation.valid) return;

      const parsedDebit = parseFloat(row.debit || 0);
      const parsedBankCharges = parseFloat(row.bank_charges || 0);
      const parsedCredit = parseFloat(row.credit || 0);
      if (
        (isNaN(parsedDebit) || parsedDebit < 0) ||
        (isNaN(parsedBankCharges) || parsedBankCharges < 0) ||
        (isNaN(parsedCredit) || parsedCredit < 0)
      ) {
        return res.status(400).json({
          success: false,
          error: 'debit, bank_charges, and credit must be valid numbers >= 0'
        });
      }
      if (parsedDebit <= 0 && parsedBankCharges <= 0 && parsedCredit <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Each transaction must have at least one positive amount (debit, bank_charges, or credit)'
        });
      }
      if (!row.date || !row.description) {
        return res.status(400).json({
          success: false,
          error: 'Each transaction requires date and description'
        });
      }

      const created = await EmiratesTransaction.create({
        accountNumber: row.account_number || null,
        date: row.date,
        description: row.description,
        details: row.details || null,
        currency: rowCurrencyValidation.currency,
        debit: parsedDebit,
        bankCharges: parsedBankCharges,
        credit: parsedCredit,
        createdBy: req.user ? req.user.id : null
      });
      createdRows.push(created);
    }

    res.status(201).json({
      success: true,
      message: 'Bulk Emirates transactions created successfully',
      createdCount: createdRows.length,
      data: createdRows
    });
  } catch (error) {
    console.error('Error bulk creating Emirates transactions:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to bulk create Emirates transactions'
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
