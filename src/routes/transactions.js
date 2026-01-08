const express = require('express');
const Transaction = require('../models/Transaction');
const { authenticateToken } = require('../middleware/auth');
const { formatAmount, roundToTwoDecimals } = require('../utils/formatAmount');

const router = express.Router();

// Get all transactions (table format)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const transactions = await Transaction.getAll();

    // Format response to match table layout
    const formattedTransactions = transactions.map(txn => ({
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

    // Get current balance (latest transaction balance - last in array since ordered ASC)
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
    console.error('Error fetching transactions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch transactions'
    });
  }
});

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
    const validPaymentTypes = ['cash', 'cheque', 'creditcard', 'online'];
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
    console.error('Error creating transaction:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create transaction'
    });
  }
});

// Update a transaction
router.put('/:id', authenticateToken, async (req, res) => {
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
    const validPaymentTypes = ['cash', 'cheque', 'creditcard', 'online'];
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
router.delete('/:id', authenticateToken, async (req, res) => {
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
router.post('/recalculate-balances', authenticateToken, async (req, res) => {
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

