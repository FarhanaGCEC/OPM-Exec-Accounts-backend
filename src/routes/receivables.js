const express = require('express');
const ReceivablesCategory = require('../models/ReceivablesCategory');
const { authenticateToken } = require('../middleware/auth');
const { requireElevatedForMutation } = require('../middleware/requireElevatedForMutation');
const { parseBulkNamesFromCsvBuffer } = require('../utils/parseBulkNamesCsv');
const { uploadCategoryNamesCsv } = require('../middleware/categoryNamesCsvUpload');

const router = express.Router();

const MAX_CATEGORY_BULK = 2000;

// Bulk create receivables categories (debtors / income parties in daily Credit dropdown)
router.post('/bulk', authenticateToken, async (req, res) => {
  try {
    const raw = req.body && Array.isArray(req.body.names) ? req.body.names : null;
    if (!raw) {
      return res.status(400).json({
        success: false,
        error: 'Request body must include a "names" array of strings'
      });
    }
    if (raw.length > MAX_CATEGORY_BULK) {
      return res.status(400).json({
        success: false,
        error: `At most ${MAX_CATEGORY_BULK} names per request`
      });
    }
    const result = await ReceivablesCategory.createMany(raw);
    res.status(201).json({
      success: true,
      message: `${result.created.length} receivables category(ies) created`,
      created: result.created.length,
      skippedDuplicates: result.skippedDuplicates,
      data: result.created
    });
  } catch (error) {
    console.error('Receivables bulk create error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to bulk create receivables categories'
    });
  }
});

router.post(
  '/bulk-csv',
  authenticateToken,
  (req, res, next) => {
    uploadCategoryNamesCsv.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          success: false,
          error: err.message || 'File upload failed'
        });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({
          success: false,
          error: 'Missing file field "file" (.csv)'
        });
      }
      const names = parseBulkNamesFromCsvBuffer(req.file.buffer);
      if (names.length > MAX_CATEGORY_BULK) {
        return res.status(400).json({
          success: false,
          error: `At most ${MAX_CATEGORY_BULK} names per file`
        });
      }
      if (names.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No names found in CSV (use one name per row or a single "name" column)'
        });
      }
      const result = await ReceivablesCategory.createMany(names);
      res.status(201).json({
        success: true,
        message: `${result.created.length} receivables category(ies) created from CSV`,
        created: result.created.length,
        skippedDuplicates: result.skippedDuplicates,
        data: result.created
      });
    } catch (error) {
      console.error('Receivables bulk CSV error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to import receivables categories'
      });
    }
  }
);

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
router.put('/:id', authenticateToken, requireElevatedForMutation, async (req, res) => {
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
router.delete('/:id', authenticateToken, requireElevatedForMutation, async (req, res) => {
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







