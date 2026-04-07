const express = require('express');
const GBPTransaction = require('../models/GBPTransaction');
const { authenticateToken } = require('../middleware/auth');
const { requireElevatedForMutation } = require('../middleware/requireElevatedForMutation');
const { formatAmount } = require('../utils/formatAmount');

const router = express.Router();

// Get all GBP transactions
router.get('/', authenticateToken, async (req, res) => {
  try {
    const transactions = await GBPTransaction.getAll();

    // Format response
    const formattedTransactions = transactions.map(txn => ({
      id: txn.id,
      accountNumber: txn.account_number || null,
      date: txn.date,
      description: txn.description,
      details: txn.details || null,
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
    console.error('Error fetching GBP transactions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch GBP transactions'
    });
  }
});

// Get bank balance (current balance)
router.get('/balance', authenticateToken, async (req, res) => {
  try {
    const balance = await GBPTransaction.getLatestBalance();

    res.json({
      success: true,
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

// Get a single GBP transaction by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const transaction = await GBPTransaction.getById(id);

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'GBP transaction not found'
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
    console.error('Error fetching GBP transaction:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch GBP transaction'
    });
  }
});

// Create a new GBP transaction
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { 
      account_number, 
      date, 
      description, 
      details, 
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

    const transaction = await GBPTransaction.create({
      accountNumber: account_number || null,
      date: formattedDate,
      description: description,
      details: details || null,
      debit: parsedDebit,
      bankCharges: parsedBankCharges,
      credit: parsedCredit,
      createdBy: createdBy
    });

    res.status(201).json({
      success: true,
      message: 'GBP transaction created successfully',
      data: {
        id: transaction.id,
        accountNumber: transaction.account_number || null,
        date: transaction.date,
        description: transaction.description,
        details: transaction.details || null,
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
    console.error('Error creating GBP transaction:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create GBP transaction'
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
      existingTransaction = await GBPTransaction.getById(id);
      if (!existingTransaction) {
        return res.status(404).json({
          success: false,
          error: 'GBP transaction not found'
        });
      }
    }
    
    const { 
      account_number, 
      date, 
      description, 
      details, 
      debit, 
      bank_charges, 
      credit 
    } = req.body;

    // For PATCH, merge with existing values
    const finalDate = date !== undefined ? date : (isPatch ? existingTransaction.date : null);
    const finalDescription = description !== undefined ? description : (isPatch ? existingTransaction.description : null);
    const finalDetails = details !== undefined ? details : (isPatch ? existingTransaction.details : null);
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

    const transaction = await GBPTransaction.update(id, {
      accountNumber: finalAccountNumber || null,
      date: formattedDate,
      description: finalDescription,
      details: finalDetails || null,
      debit: parsedDebit,
      bankCharges: parsedBankCharges,
      credit: parsedCredit
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'GBP transaction not found'
      });
    }

    res.json({
      success: true,
      message: 'GBP transaction updated successfully',
      data: {
        id: transaction.id,
        accountNumber: transaction.account_number || null,
        date: transaction.date,
        description: transaction.description,
        details: transaction.details || null,
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
    console.error('Error updating GBP transaction:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update GBP transaction'
    });
  }
};

// Update a GBP transaction (PUT - full update)
router.put('/:id', authenticateToken, requireElevatedForMutation, (req, res) =>
  updateTransactionHandler(req, res, false)
);

// Update a GBP transaction (PATCH - partial update)
router.patch('/:id', authenticateToken, requireElevatedForMutation, (req, res) =>
  updateTransactionHandler(req, res, true)
);

// Delete a GBP transaction
router.delete('/:id', authenticateToken, requireElevatedForMutation, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await GBPTransaction.delete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'GBP transaction not found'
      });
    }

    res.json({
      success: true,
      message: 'GBP transaction deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting GBP transaction:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete GBP transaction'
    });
  }
});

// Recalculate all balances (useful for fixing incorrect balances)
router.post('/recalculate-balances', authenticateToken, requireElevatedForMutation, async (req, res) => {
  try {
    const finalBalance = await GBPTransaction.recalculateAllBalances();
    
    res.json({
      success: true,
      message: 'All GBP transaction balances recalculated successfully',
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
