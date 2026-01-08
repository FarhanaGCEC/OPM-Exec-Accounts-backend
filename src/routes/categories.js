const express = require('express');
const PayablesCategory = require('../models/PayablesCategory');
const ReceivablesCategory = require('../models/ReceivablesCategory');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get all categories (both payables and receivables)
router.get('/', authenticateToken, async (req, res) => {
  try {
    // Get both payables and receivables categories
    const payables = await PayablesCategory.getAll();
    const receivables = await ReceivablesCategory.getAll();

    // Format payables with type
    const payablesFormatted = payables.map(cat => ({
      ...cat,
      categoryType: 'payable'
    }));

    // Format receivables with type
    const receivablesFormatted = receivables.map(cat => ({
      ...cat,
      categoryType: 'receivable'
    }));

    // Combine both
    const allCategories = [...payablesFormatted, ...receivablesFormatted];

    res.json({
      success: true,
      data: {
        payables: payablesFormatted,
        receivables: receivablesFormatted,
        all: allCategories
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch categories'
    });
  }
});

module.exports = router;







