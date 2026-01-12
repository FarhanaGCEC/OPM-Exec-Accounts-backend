const express = require('express');
const PDC = require('../models/PDC');
const { authenticateToken } = require('../middleware/auth');
const { formatAmount, roundToTwoDecimals } = require('../utils/formatAmount');

const router = express.Router();

// Get all post-dated cheques
router.get('/', authenticateToken, async (req, res) => {
  try {
    const pdcs = await PDC.getAll();
    res.json({
      success: true,
      data: pdcs.map(pdc => {
        const formatted = { ...pdc };
        formatted.amount = formatAmount(pdc.amount);
        return formatted;
      })
    });
  } catch (error) {
    console.error('Error fetching PDCs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch post-dated cheques'
    });
  }
});

// Get PDCs near cheque date (for dashboard reminders)
router.get('/reminders', authenticateToken, async (req, res) => {
  try {
    // Get days parameter from query string (default: 30 days)
    const days = parseInt(req.query.days) || 30;
    
    // Validate days parameter
    if (isNaN(days) || days < 1 || days > 365) {
      return res.status(400).json({
        success: false,
        error: 'Days parameter must be a number between 1 and 365'
      });
    }

    const pdcs = await PDC.getNearChequeDate(days);
    
    // Debug: Also check what pdc_types actually exist in the database
    if (pdcs.length === 0 && req.query.debug === 'true') {
      const { pool } = require('../config/database');
      const allTypes = await pool.query(`
        SELECT DISTINCT pdc_type, COUNT(*) as count 
        FROM post_dated_cheques 
        GROUP BY pdc_type
      `);
      const allPDCs = await pool.query(`
        SELECT id, cheque_date, pdc_type, customer_name 
        FROM post_dated_cheques 
        ORDER BY cheque_date DESC 
        LIMIT 10
      `);
      
      return res.json({
        success: true,
        data: [],
        count: 0,
        days_lookahead: days,
        debug: {
          available_types: allTypes.rows,
          recent_pdcs: allPDCs.rows,
          message: 'No PDCs found. Check debug info above.'
        }
      });
    }
    
    res.json({
      success: true,
      data: pdcs.map(pdc => {
        const formatted = { ...pdc };
        formatted.amount = formatAmount(pdc.amount);
        // Ensure days_remaining is a number
        formatted.days_remaining = parseInt(pdc.days_remaining) || 0;
        return formatted;
      }),
      count: pdcs.length,
      days_lookahead: days
    });
  } catch (error) {
    console.error('Error fetching PDC reminders:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch PDC reminders',
      details: error.message
    });
  }
});

// Get a single PDC by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const pdc = await PDC.getById(id);

    if (!pdc) {
      return res.status(404).json({
        success: false,
        error: 'Post-dated cheque not found'
      });
    }

    const formattedPDC = { ...pdc };
    formattedPDC.amount = formatAmount(pdc.amount);
    res.json({
      success: true,
      data: formattedPDC
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch post-dated cheque'
    });
  }
});

// Create a new PDC
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { chequeDate, chequeNumber, customerName, amount, chequeType, pdcType, description } = req.body;

    // Validation
    if (!chequeDate || !chequeNumber || !customerName || !amount || !chequeType || !pdcType) {
      return res.status(400).json({
        success: false,
        error: 'Cheque date, cheque number, customer name, amount, cheque type, and PDC type are required'
      });
    }

    // Validate cheque type
    const validChequeTypes = ['Payment Cheque', 'Security Cheque', 'Other'];
    if (!validChequeTypes.includes(chequeType)) {
      return res.status(400).json({
        success: false,
        error: `Cheque type must be one of: ${validChequeTypes.join(', ')}`
      });
    }

    // Validate PDC type
    const validPDCTypes = ['GCEC PDC', 'Customer PDC', 'Custom PDC'];
    if (!validPDCTypes.includes(pdcType)) {
      return res.status(400).json({
        success: false,
        error: `PDC type must be one of: ${validPDCTypes.join(', ')}`
      });
    }

    // If Custom PDC, description is required
    if (pdcType === 'Custom PDC' && (!description || description.trim() === '')) {
      return res.status(400).json({
        success: false,
        error: 'Description is required for Custom PDC'
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
    let formattedDate = chequeDate;
    if (chequeDate.includes('/')) {
      const [day, month, year] = chequeDate.split('/');
      formattedDate = `${year}-${month}-${day}`;
    }

    // Get user ID from JWT token
    const createdBy = req.user ? req.user.id : null;

    const pdc = await PDC.create({
      chequeDate: formattedDate,
      chequeNumber: chequeNumber.trim(),
      customerName: customerName.trim(),
      amount: roundedAmount,
      chequeType: chequeType,
      pdcType: pdcType,
      description: description ? description.trim() : null,
      createdBy: createdBy
    });

    const formattedPDC = { ...pdc };
    formattedPDC.amount = formatAmount(pdc.amount);
    res.status(201).json({
      success: true,
      message: 'Post-dated cheque created successfully',
      data: formattedPDC
    });
  } catch (error) {
    console.error('Error creating PDC:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create post-dated cheque'
    });
  }
});

// Update a PDC
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { chequeDate, chequeNumber, customerName, amount, chequeType, pdcType, description } = req.body;

    // Validation
    if (!chequeDate || !chequeNumber || !customerName || !amount || !chequeType || !pdcType) {
      return res.status(400).json({
        success: false,
        error: 'Cheque date, cheque number, customer name, amount, cheque type, and PDC type are required'
      });
    }

    // Validate cheque type
    const validChequeTypes = ['Payment Cheque', 'Security Cheque', 'Other'];
    if (!validChequeTypes.includes(chequeType)) {
      return res.status(400).json({
        success: false,
        error: `Cheque type must be one of: ${validChequeTypes.join(', ')}`
      });
    }

    // Validate PDC type
    const validPDCTypes = ['GCEC PDC', 'Customer PDC', 'Custom PDC'];
    if (!validPDCTypes.includes(pdcType)) {
      return res.status(400).json({
        success: false,
        error: `PDC type must be one of: ${validPDCTypes.join(', ')}`
      });
    }

    // If Custom PDC, description is required
    if (pdcType === 'Custom PDC' && (!description || description.trim() === '')) {
      return res.status(400).json({
        success: false,
        error: 'Description is required for Custom PDC'
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
    let formattedDate = chequeDate;
    if (chequeDate.includes('/')) {
      const [day, month, year] = chequeDate.split('/');
      formattedDate = `${year}-${month}-${day}`;
    }

    const pdc = await PDC.update(id, {
      chequeDate: formattedDate,
      chequeNumber: chequeNumber.trim(),
      customerName: customerName.trim(),
      amount: roundedAmount,
      chequeType: chequeType,
      pdcType: pdcType,
      description: description ? description.trim() : null
    });

    if (!pdc) {
      return res.status(404).json({
        success: false,
        error: 'Post-dated cheque not found'
      });
    }

    const formattedPDC = { ...pdc };
    formattedPDC.amount = formatAmount(pdc.amount);
    res.json({
      success: true,
      message: 'Post-dated cheque updated successfully',
      data: formattedPDC
    });
  } catch (error) {
    console.error('Error updating PDC:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update post-dated cheque'
    });
  }
});

// Delete a PDC
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await PDC.delete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Post-dated cheque not found'
      });
    }

    res.json({
      success: true,
      message: 'Post-dated cheque deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting PDC:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete post-dated cheque'
    });
  }
});

module.exports = router;

