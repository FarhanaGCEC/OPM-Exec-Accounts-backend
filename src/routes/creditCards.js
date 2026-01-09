const express = require('express');
const CreditCard = require('../models/CreditCard');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get all credit cards
router.get('/', authenticateToken, async (req, res) => {
  try {
    const cards = await CreditCard.getAll();
    res.json({
      success: true,
      data: cards
    });
  } catch (error) {
    console.error('Error fetching credit cards:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch credit cards'
    });
  }
});

// Get a single credit card by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const card = await CreditCard.getById(id);

    if (!card) {
      return res.status(404).json({
        success: false,
        error: 'Credit card not found'
      });
    }

    res.json({
      success: true,
      data: card
    });
  } catch (error) {
    console.error('Error fetching credit card:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch credit card'
    });
  }
});

// Create a new credit card
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { issuingBank, cardHolder, cardNumber, expiry, cvv, amountLimit, isDefault } = req.body;

    // Validation
    if (!issuingBank || !cardHolder || !cardNumber || !expiry) {
      return res.status(400).json({
        success: false,
        error: 'Issuing bank, card holder, card number, and expiry are required'
      });
    }

    // Validate card number format (remove spaces for validation)
    const cleanCardNumber = cardNumber.replace(/\s/g, '');
    if (cleanCardNumber.length < 13 || cleanCardNumber.length > 19 || !/^\d+$/.test(cleanCardNumber)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid card number format'
      });
    }

    // Validate expiry format (MM-YY or MMM-YY)
    const expiryRegex = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2})$/i;
    if (!expiryRegex.test(expiry)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid expiry format. Expected format: MMM-YY (e.g., Feb-28)'
      });
    }

    // Parse amount limit if provided
    let parsedAmountLimit = null;
    if (amountLimit) {
      parsedAmountLimit = parseFloat(amountLimit);
      if (isNaN(parsedAmountLimit) || parsedAmountLimit < 0) {
        return res.status(400).json({
          success: false,
          error: 'Amount limit must be a valid positive number'
        });
      }
    }

    // Format expiry to capitalize first letter
    const formattedExpiry = expiry.charAt(0).toUpperCase() + expiry.slice(1).toLowerCase();

    // Manual cards cannot be system cards
    const card = await CreditCard.create({
      issuingBank: issuingBank.trim(),
      cardHolder: cardHolder.trim(),
      cardNumber: cardNumber.trim(),
      expiry: formattedExpiry,
      cvv: cvv || null,
      amountLimit: parsedAmountLimit,
      isSystem: false,
      isDefault: isDefault || false
    });

    res.status(201).json({
      success: true,
      message: 'Credit card created successfully',
      data: card
    });
  } catch (error) {
    console.error('Error creating credit card:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create credit card'
    });
  }
});

// Update a credit card
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { issuingBank, cardHolder, cardNumber, expiry, cvv, amountLimit, isDefault } = req.body;

    // Check if card exists
    const existingCard = await CreditCard.getById(id);
    if (!existingCard) {
      return res.status(404).json({
        success: false,
        error: 'Credit card not found'
      });
    }

    // Validation
    if (!issuingBank || !cardHolder || !cardNumber || !expiry) {
      return res.status(400).json({
        success: false,
        error: 'Issuing bank, card holder, card number, and expiry are required'
      });
    }

    // Validate card number format (remove spaces for validation)
    const cleanCardNumber = cardNumber.replace(/\s/g, '');
    if (cleanCardNumber.length < 13 || cleanCardNumber.length > 19 || !/^\d+$/.test(cleanCardNumber)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid card number format'
      });
    }

    // Validate expiry format (MM-YY or MMM-YY)
    const expiryRegex = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2})$/i;
    if (!expiryRegex.test(expiry)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid expiry format. Expected format: MMM-YY (e.g., Feb-28)'
      });
    }

    // Parse amount limit if provided
    let parsedAmountLimit = null;
    if (amountLimit) {
      parsedAmountLimit = parseFloat(amountLimit);
      if (isNaN(parsedAmountLimit) || parsedAmountLimit < 0) {
        return res.status(400).json({
          success: false,
          error: 'Amount limit must be a valid positive number'
        });
      }
    }

    // Format expiry to capitalize first letter
    const formattedExpiry = expiry.charAt(0).toUpperCase() + expiry.slice(1).toLowerCase();

    const card = await CreditCard.update(id, {
      issuingBank: issuingBank.trim(),
      cardHolder: cardHolder.trim(),
      cardNumber: cardNumber.trim(),
      expiry: formattedExpiry,
      cvv: cvv || null,
      amountLimit: parsedAmountLimit,
      isDefault: isDefault !== undefined ? isDefault : existingCard.is_default
    });

    if (!card) {
      return res.status(404).json({
        success: false,
        error: 'Credit card not found'
      });
    }

    res.json({
      success: true,
      message: 'Credit card updated successfully',
      data: card
    });
  } catch (error) {
    console.error('Error updating credit card:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update credit card'
    });
  }
});

// Delete a credit card (only if not a system card)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if card exists and is system card
    const card = await CreditCard.getById(id);
    if (!card) {
      return res.status(404).json({
        success: false,
        error: 'Credit card not found'
      });
    }

    if (card.is_system) {
      return res.status(403).json({
        success: false,
        error: 'Cannot delete system credit card'
      });
    }

    const deleted = await CreditCard.delete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Credit card not found'
      });
    }

    res.json({
      success: true,
      message: 'Credit card deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting credit card:', error);
    if (error.message === 'Cannot delete system credit card') {
      return res.status(403).json({
        success: false,
        error: error.message
      });
    }
    res.status(500).json({
      success: false,
      error: 'Failed to delete credit card'
    });
  }
});

module.exports = router;
