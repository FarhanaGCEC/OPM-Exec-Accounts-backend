const express = require('express');
const CreditCardPayment = require('../models/CreditCardPayment');
const { authenticateToken } = require('../middleware/auth');
const { formatAmount, roundToTwoDecimals } = require('../utils/formatAmount');

const router = express.Router();

// Get all credit card payments
router.get('/', authenticateToken, async (req, res) => {
  try {
    const payments = await CreditCardPayment.getAll();
    res.json({
      success: true,
      data: payments.map(payment => {
        const formatted = { ...payment };
        formatted.amount = formatAmount(payment.amount);
        return formatted;
      })
    });
  } catch (error) {
    console.error('Error fetching credit card payments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch credit card payments'
    });
  }
});

// Get a single credit card payment by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const payment = await CreditCardPayment.getById(id);

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Credit card payment not found'
      });
    }

    const formattedPayment = { ...payment };
    formattedPayment.amount = formatAmount(payment.amount);
    res.json({
      success: true,
      data: formattedPayment
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch credit card payment'
    });
  }
});

// Create a new credit card payment
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { paymentDate, customerName, paymentMethod, amount } = req.body;

    // Validation
    if (!paymentDate || !customerName || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Payment date, customer name, and amount are required'
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

    // Convert date format if needed (DD/MM/YYYY or DD-MMM-YYYY to YYYY-MM-DD)
    let formattedDate = paymentDate;
    if (paymentDate.includes('/')) {
      const [day, month, year] = paymentDate.split('/');
      formattedDate = `${year}-${month}-${day}`;
    } else if (paymentDate.includes('-')) {
      // Handle format like "10-Jan-2024"
      const months = {
        'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
        'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
      };
      const parts = paymentDate.split('-');
      if (parts.length === 3) {
        const day = parts[0].padStart(2, '0');
        const month = months[parts[1]] || parts[1];
        const year = parts[2];
        formattedDate = `${year}-${month}-${day}`;
      }
    }

    // Get user ID from JWT token
    const createdBy = req.user ? req.user.id : null;

    const payment = await CreditCardPayment.create({
      paymentDate: formattedDate,
      customerName: customerName.trim(),
      paymentMethod: paymentMethod || 'Credit Card',
      amount: roundedAmount,
      createdBy: createdBy
    });

    const formattedPayment = { ...payment };
    formattedPayment.amount = formatAmount(payment.amount);
    res.status(201).json({
      success: true,
      message: 'Credit card payment created successfully',
      data: formattedPayment
    });
  } catch (error) {
    console.error('Error creating credit card payment:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create credit card payment'
    });
  }
});

// Update a credit card payment
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentDate, customerName, paymentMethod, amount } = req.body;

    // Validation
    if (!paymentDate || !customerName || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Payment date, customer name, and amount are required'
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

    // Convert date format if needed (DD/MM/YYYY or DD-MMM-YYYY to YYYY-MM-DD)
    let formattedDate = paymentDate;
    if (paymentDate.includes('/')) {
      const [day, month, year] = paymentDate.split('/');
      formattedDate = `${year}-${month}-${day}`;
    } else if (paymentDate.includes('-')) {
      // Handle format like "10-Jan-2024"
      const months = {
        'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
        'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
      };
      const parts = paymentDate.split('-');
      if (parts.length === 3) {
        const day = parts[0].padStart(2, '0');
        const month = months[parts[1]] || parts[1];
        const year = parts[2];
        formattedDate = `${year}-${month}-${day}`;
      }
    }

    const payment = await CreditCardPayment.update(id, {
      paymentDate: formattedDate,
      customerName: customerName.trim(),
      paymentMethod: paymentMethod || 'Credit Card',
      amount: roundedAmount
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Credit card payment not found'
      });
    }

    const formattedPayment = { ...payment };
    formattedPayment.amount = formatAmount(payment.amount);
    res.json({
      success: true,
      message: 'Credit card payment updated successfully',
      data: formattedPayment
    });
  } catch (error) {
    console.error('Error updating credit card payment:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update credit card payment'
    });
  }
});

// Delete a credit card payment
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await CreditCardPayment.delete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Credit card payment not found'
      });
    }

    res.json({
      success: true,
      message: 'Credit card payment deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting credit card payment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete credit card payment'
    });
  }
});

module.exports = router;



