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
      data: payments.map(payment => ({
        id: payment.id,
        payment_date: payment.payment_date,
        card_holder: payment.card_holder || payment.customer_name || null,
        card_no: payment.card_number || null,
        amount: formatAmount(payment.amount),
        remarks: payment.remarks || null,
        credit_card_id: payment.credit_card_id || payment.card_id || null,
        issuing_bank: payment.issuing_bank || null,
        created_at: payment.created_at,
        updated_at: payment.updated_at
      }))
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

    const formattedPayment = {
      id: payment.id,
      payment_date: payment.payment_date,
      card_holder: payment.card_holder || payment.customer_name || null,
      card_no: payment.card_number || null,
      amount: formatAmount(payment.amount),
      remarks: payment.remarks || null,
      credit_card_id: payment.credit_card_id || payment.card_id || null,
      issuing_bank: payment.issuing_bank || null,
      created_at: payment.created_at,
      updated_at: payment.updated_at
    };
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
    const { payment_date, credit_card_id, card_holder, card_no, amount, remarks } = req.body;

    // Validation
    if (!payment_date || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Payment date and amount are required'
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

    // Convert date format if needed (DD/MM/YYYY or DD-MM-YY to YYYY-MM-DD)
    let formattedDate = payment_date;
    if (typeof payment_date === 'string') {
      if (payment_date.includes('/')) {
        const parts = payment_date.split('/');
        if (parts.length === 3) {
          const [day, month, year] = parts;
          formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        }
      } else if (payment_date.includes('-') && !payment_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        // Handle format like "10-Jan-2024" or "DD-MM-YY"
        const months = {
          'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
          'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
        };
        const parts = payment_date.split('-');
        if (parts.length === 3) {
          const day = parts[0].padStart(2, '0');
          const month = months[parts[1]] || parts[1].padStart(2, '0');
          let year = parts[2];
          // Handle 2-digit year
          if (year.length === 2) {
            year = '20' + year;
          }
          formattedDate = `${year}-${month}-${day}`;
        }
      }
    }

    // Validate date
    const dateObj = new Date(formattedDate);
    if (isNaN(dateObj.getTime())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date format. Use YYYY-MM-DD, DD/MM/YYYY, or DD-MM-YY'
      });
    }

    // Get user ID from JWT token
    const createdBy = req.user ? req.user.id : null;

    const payment = await CreditCardPayment.create({
      paymentDate: formattedDate,
      creditCardId: credit_card_id || null,
      customerName: card_holder || null, // Keep for backward compatibility
      paymentMethod: 'Credit Card',
      amount: roundedAmount,
      remarks: remarks || null,
      createdBy: createdBy
    });

    const formattedPayment = {
      id: payment.id,
      payment_date: payment.payment_date,
      card_holder: payment.card_holder || payment.customer_name || null,
      card_no: payment.card_number || null,
      amount: formatAmount(payment.amount),
      remarks: payment.remarks || null,
      credit_card_id: payment.credit_card_id || payment.card_id || null,
      issuing_bank: payment.issuing_bank || null,
      created_at: payment.created_at,
      updated_at: payment.updated_at
    };

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

// Update a credit card payment (full update)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_date, credit_card_id, card_holder, card_no, amount, remarks } = req.body;

    const updateData = {};

    // Validate and format payment_date if provided
    if (payment_date !== undefined) {
      let formattedDate = payment_date;
      if (typeof payment_date === 'string') {
        if (payment_date.includes('/')) {
          const parts = payment_date.split('/');
          if (parts.length === 3) {
            const [day, month, year] = parts;
            formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }
        } else if (payment_date.includes('-') && !payment_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const months = {
            'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
            'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
          };
          const parts = payment_date.split('-');
          if (parts.length === 3) {
            const day = parts[0].padStart(2, '0');
            const month = months[parts[1]] || parts[1].padStart(2, '0');
            let year = parts[2];
            if (year.length === 2) {
              year = '20' + year;
            }
            formattedDate = `${year}-${month}-${day}`;
          }
        }
      }

      // Validate date
      const dateObj = new Date(formattedDate);
      if (isNaN(dateObj.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid date format. Use YYYY-MM-DD, DD/MM/YYYY, or DD-MM-YY'
        });
      }

      updateData.paymentDate = formattedDate;
    }

    // Validate and format amount if provided
    if (amount !== undefined) {
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Amount must be greater than 0'
        });
      }
      updateData.amount = roundToTwoDecimals(parsedAmount);
    }

    // Add optional fields
    if (credit_card_id !== undefined) {
      updateData.creditCardId = credit_card_id || null;
    }
    if (card_holder !== undefined) {
      updateData.customerName = card_holder || null; // Keep for backward compatibility
    }
    if (remarks !== undefined) {
      updateData.remarks = remarks || null;
    }

    const payment = await CreditCardPayment.update(id, updateData);

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Credit card payment not found'
      });
    }

    const formattedPayment = {
      id: payment.id,
      payment_date: payment.payment_date,
      card_holder: payment.card_holder || payment.customer_name || null,
      card_no: payment.card_number || null,
      amount: formatAmount(payment.amount),
      remarks: payment.remarks || null,
      credit_card_id: payment.credit_card_id || payment.card_id || null,
      issuing_bank: payment.issuing_bank || null,
      created_at: payment.created_at,
      updated_at: payment.updated_at
    };

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

// Partial update a credit card payment
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_date, credit_card_id, card_holder, card_no, amount, remarks } = req.body;

    const updateData = {};

    // Validate and format payment_date if provided
    if (payment_date !== undefined) {
      let formattedDate = payment_date;
      if (typeof payment_date === 'string') {
        if (payment_date.includes('/')) {
          const parts = payment_date.split('/');
          if (parts.length === 3) {
            const [day, month, year] = parts;
            formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }
        } else if (payment_date.includes('-') && !payment_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const months = {
            'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
            'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
          };
          const parts = payment_date.split('-');
          if (parts.length === 3) {
            const day = parts[0].padStart(2, '0');
            const month = months[parts[1]] || parts[1].padStart(2, '0');
            let year = parts[2];
            if (year.length === 2) {
              year = '20' + year;
            }
            formattedDate = `${year}-${month}-${day}`;
          }
        }
      }

      // Validate date
      const dateObj = new Date(formattedDate);
      if (isNaN(dateObj.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid date format. Use YYYY-MM-DD, DD/MM/YYYY, or DD-MM-YY'
        });
      }

      updateData.paymentDate = formattedDate;
    }

    // Validate and format amount if provided
    if (amount !== undefined) {
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Amount must be greater than 0'
        });
      }
      updateData.amount = roundToTwoDecimals(parsedAmount);
    }

    // Add optional fields
    if (credit_card_id !== undefined) {
      updateData.creditCardId = credit_card_id || null;
    }
    if (card_holder !== undefined) {
      updateData.customerName = card_holder || null;
    }
    if (remarks !== undefined) {
      updateData.remarks = remarks || null;
    }

    const payment = await CreditCardPayment.update(id, updateData);

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Credit card payment not found'
      });
    }

    const formattedPayment = {
      id: payment.id,
      payment_date: payment.payment_date,
      card_holder: payment.card_holder || payment.customer_name || null,
      card_no: payment.card_number || null,
      amount: formatAmount(payment.amount),
      remarks: payment.remarks || null,
      credit_card_id: payment.credit_card_id || payment.card_id || null,
      issuing_bank: payment.issuing_bank || null,
      created_at: payment.created_at,
      updated_at: payment.updated_at
    };

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



