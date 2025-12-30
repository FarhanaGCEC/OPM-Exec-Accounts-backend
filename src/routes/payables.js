const express = require('express');
const PayablesCategory = require('../models/PayablesCategory');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get all payables categories
router.get('/', authenticateToken, async (req, res) => {
  try {
    const categories = await PayablesCategory.getAll();
    res.json({
      success: true,
      data: categories
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payables categories'
    });
  }
});

// Get a single payables category by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const category = await PayablesCategory.getById(id);

    if (!category) {
      return res.status(404).json({
        success: false,
        error: 'Payables category not found'
      });
    }

    res.json({
      success: true,
      data: category
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payables category'
    });
  }
});

// Create a new payables category
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name } = req.body;

    // Validation
    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Category name is required'
      });
    }

    const category = await PayablesCategory.create(name.trim());

    res.status(201).json({
      success: true,
      message: 'Payables category created successfully',
      data: category
    });
  } catch (error) {
    if (error.message === 'Category name already exists') {
      return res.status(409).json({
        success: false,
        error: error.message
      });
    }
    res.status(500).json({
      success: false,
      error: 'Failed to create payables category'
    });
  }
});

// Update a payables category
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    // Validation
    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Category name is required'
      });
    }

    const category = await PayablesCategory.update(id, name.trim());

    if (!category) {
      return res.status(404).json({
        success: false,
        error: 'Payables category not found'
      });
    }

    res.json({
      success: true,
      message: 'Payables category updated successfully',
      data: category
    });
  } catch (error) {
    if (error.message === 'Category name already exists') {
      return res.status(409).json({
        success: false,
        error: error.message
      });
    }
    res.status(500).json({
      success: false,
      error: 'Failed to update payables category'
    });
  }
});

// Delete a payables category
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await PayablesCategory.delete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Payables category not found'
      });
    }

    res.json({
      success: true,
      message: 'Payables category deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to delete payables category'
    });
  }
});

module.exports = router;

