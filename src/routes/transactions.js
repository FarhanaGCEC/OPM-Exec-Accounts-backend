const express = require('express');
const Transaction = require('../models/Transaction');
const PDC = require('../models/PDC');
const PurchaseBill = require('../models/PurchaseBill');
const { authenticateToken } = require('../middleware/auth');
const { formatAmount, roundToTwoDecimals } = require('../utils/formatAmount');
const { pool } = require('../config/database');

const router = express.Router();

// Get all transactions with filters (Daily transactions, GCEC PDC, Customer PDC, Purchase Bills)
router.get('/all', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Build date filter conditions and parameters
    const buildDateFilter = (dateColumn, baseParamCount = 0) => {
      const conditions = [];
      const params = [];
      let paramCount = baseParamCount;

      if (startDate) {
        paramCount++;
        conditions.push(`${dateColumn} >= $${paramCount}`);
        params.push(startDate);
      }
      if (endDate) {
        paramCount++;
        conditions.push(`${dateColumn} <= $${paramCount}`);
        params.push(endDate);
      }

      return {
        whereClause: conditions.length > 0 ? conditions.join(' AND ') : '',
        params: params,
        paramCount: paramCount
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
    const dailyTransactions = transactionsResult.rows.map(txn => ({
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

    // Combine all transactions in the specified order
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

