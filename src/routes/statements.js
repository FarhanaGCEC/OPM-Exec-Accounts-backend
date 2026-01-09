const express = require('express');
const StatementController = require('../controllers/statementController');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// POST /api/statements/init/:month - Initialize statements for a month
router.post('/init/:month', authenticateToken, StatementController.initializeStatements);

// GET /api/statements/detail/:id - Get single statement by ID (must come before :month to avoid route conflict)
router.get('/detail/:id', authenticateToken, StatementController.getStatement);

// POST/PUT/PATCH /api/statements/:id - Update statement (upsert behavior)
// These must come before GET /:month to avoid route conflicts
router.post('/:id', authenticateToken, StatementController.updateStatement);
router.put('/:id', authenticateToken, StatementController.updateStatement);
router.patch('/:id', authenticateToken, StatementController.updateStatement);

// GET /api/statements/:month - List statements for a month (or "all" for all statements)
// This should be last as it matches any string (including UUIDs) but only for GET requests
router.get('/:month', authenticateToken, StatementController.listStatements);

module.exports = router;
