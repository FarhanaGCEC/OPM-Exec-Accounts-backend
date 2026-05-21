const express = require('express');
const CardController = require('../controllers/cardController');
const { authenticateToken } = require('../middleware/auth');
const { requireAdminForCards } = require('../middleware/requireAdminForCards');

const router = express.Router();

// GET /api/cards - List all cards
router.get('/', authenticateToken, CardController.listCards);

// GET /api/cards/:id - Get single card
router.get('/:id', authenticateToken, CardController.getCard);

// POST /api/cards - Create new card (admin only)
router.post('/', authenticateToken, requireAdminForCards, CardController.createCard);

// PATCH /api/cards/:id/activate - Activate card (must come before /:id to avoid route conflict)
router.patch('/:id/activate', authenticateToken, requireAdminForCards, CardController.activateCard);

// PUT /api/cards/:id - Update card
router.put('/:id', authenticateToken, requireAdminForCards, CardController.updateCard);

// PATCH /api/cards/:id - Update card (partial update)
router.patch('/:id', authenticateToken, requireAdminForCards, CardController.updateCard);

// DELETE /api/cards/:id - Deactivate card
router.delete('/:id', authenticateToken, requireAdminForCards, CardController.deleteCard);

module.exports = router;
