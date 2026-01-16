const express = require('express');
const StatementController = require('../controllers/statementController');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Middleware to validate month format (YYYY-MM or "all")
const validateMonthFormat = (req, res, next) => {
  const { month } = req.params;
  
  // Allow "all" or valid YYYY-MM format
  if (month === 'all' || /^\d{4}-\d{2}$/.test(month)) {
    return next();
  }
  
  // If it looks like a UUID or invalid format, treat as invalid month
  return res.status(400).json({
    success: false,
    error: 'Invalid month format. Expected YYYY-MM (e.g., 2024-02) or "all". To get a statement by ID, use /api/statements/detail/:id'
  });
};

// POST /api/statements/init/:month - Initialize statements for a month
router.post('/init/:month', authenticateToken, validateMonthFormat, StatementController.initializeStatements);

// GET /api/statements/detail/:id - Get single statement by ID (must come before :month to avoid route conflict)
router.get('/detail/:id', authenticateToken, StatementController.getStatement);

// GET /api/statements?year=YYYY&months=1,2,3 - List statements for multiple months using query parameters
// This must come before /:month to handle query parameter requests
router.get('/', authenticateToken, StatementController.listStatements);

// POST/PUT/PATCH /api/statements/:id - Update statement (upsert behavior)
// These must come before GET /:month to avoid route conflicts
router.post('/:id', authenticateToken, StatementController.updateStatement);
router.put('/:id', authenticateToken, StatementController.updateStatement);
router.patch('/:id', authenticateToken, StatementController.updateStatement);

// GET /api/statements/:month - List statements for a month (or "all" for all statements)
// This should be last as it matches any string (including UUIDs) but only for GET requests
// Validation middleware ensures only valid month formats or "all" are processed
router.get('/:month', authenticateToken, validateMonthFormat, StatementController.listStatements);

module.exports = router;
