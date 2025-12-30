const express = require('express');
const ReceivablesCategory = require('../models/ReceivablesCategory');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get all receivables categories
router.get('/', authenticateToken, async (req, res) => {
  try {
    const categories = await ReceivablesCategory.getAll();
    res.json({
      success: true,
      data: categories
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch receivables categories'
    });
  }
});

// Get a single receivables category by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const category = await ReceivablesCategory.getById(id);

    if (!category) {
      return res.status(404).json({
        success: false,
        error: 'Receivables category not found'
      });
    }

    res.json({
      success: true,
      data: category
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch receivables category'
    });
  }
});

// Create a new receivables category
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

    const category = await ReceivablesCategory.create(name.trim());

    res.status(201).json({
      success: true,
      message: 'Receivables category created successfully',
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
      error: 'Failed to create receivables category'
    });
  }
});

// Update a receivables category
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

    const category = await ReceivablesCategory.update(id, name.trim());

    if (!category) {
      return res.status(404).json({
        success: false,
        error: 'Receivables category not found'
      });
    }

    res.json({
      success: true,
      message: 'Receivables category updated successfully',
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
      error: 'Failed to update receivables category'
    });
  }
});

// Delete a receivables category
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await ReceivablesCategory.delete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Receivables category not found'
      });
    }

    res.json({
      success: true,
      message: 'Receivables category deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to delete receivables category'
    });
  }
});

module.exports = router;

