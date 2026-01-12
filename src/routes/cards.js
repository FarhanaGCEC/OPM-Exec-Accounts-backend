const express = require('express');
const CardController = require('../controllers/cardController');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// GET /api/cards - List all cards
router.get('/', authenticateToken, CardController.listCards);

// GET /api/cards/:id - Get single card
router.get('/:id', authenticateToken, CardController.getCard);

// POST /api/cards - Create new card
router.post('/', authenticateToken, CardController.createCard);

// PATCH /api/cards/:id/activate - Activate card (must come before /:id to avoid route conflict)
router.patch('/:id/activate', authenticateToken, CardController.activateCard);

// PUT /api/cards/:id - Update card
router.put('/:id', authenticateToken, CardController.updateCard);

// PATCH /api/cards/:id - Update card (partial update)
router.patch('/:id', authenticateToken, CardController.updateCard);

// DELETE /api/cards/:id - Deactivate card
router.delete('/:id', authenticateToken, CardController.deleteCard);

module.exports = router;
