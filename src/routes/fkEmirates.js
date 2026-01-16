const express = require('express');
const EmiratesTransaction = require('../models/EmiratesTransaction');
const { authenticateToken } = require('../middleware/auth');
const { formatAmount } = require('../utils/formatAmount');

const router = express.Router();

// Get all Emirates transactions
router.get('/', authenticateToken, async (req, res) => {
  try {
    const transactions = await EmiratesTransaction.getAll();

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

    // Get current balance (latest transaction balance)
    const currentBalance = transactions.length > 0 
      ? formatAmount(transactions[transactions.length - 1].balance) 
      : "0.00";

    res.json({
      success: true,
      data: formattedTransactions,
      currentBalance: currentBalance,
      totalTransactions: transactions.length
    });
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
    const { currency } = req.query;
    const transactionCurrency = currency || 'AED';

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

    // Validate currency
    const validCurrencies = ['AED', 'USD', 'GBP'];
    const transactionCurrency = (currency || 'AED').toUpperCase();
    if (!validCurrencies.includes(transactionCurrency)) {
      return res.status(400).json({
        success: false,
        error: `Currency must be one of: ${validCurrencies.join(', ')}`
      });
    }

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
      currency: transactionCurrency,
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

    // Validate currency
    const validCurrencies = ['AED', 'USD', 'GBP'];
    const transactionCurrency = (finalCurrency || 'AED').toUpperCase();
    if (!validCurrencies.includes(transactionCurrency)) {
      return res.status(400).json({
        success: false,
        error: `Currency must be one of: ${validCurrencies.join(', ')}`
      });
    }

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
      currency: transactionCurrency,
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
router.put('/:id', authenticateToken, (req, res) => updateTransactionHandler(req, res, false));

// Update a Emirates transaction (PATCH - partial update)
router.patch('/:id', authenticateToken, (req, res) => updateTransactionHandler(req, res, true));

// Delete a Emirates transaction
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
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
router.post('/recalculate-balances', authenticateToken, async (req, res) => {
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
