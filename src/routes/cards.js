const express = require('express');
const CardController = require('../controllers/cardController');
const { authenticateToken } = require('../middleware/auth');
const { requireElevatedForMutation } = require('../middleware/requireElevatedForMutation');

const router = express.Router();

// GET /api/cards - List all cards
router.get('/', authenticateToken, CardController.listCards);

// GET /api/cards/:id - Get single card
router.get('/:id', authenticateToken, CardController.getCard);

// POST /api/cards - Create new card
router.post('/', authenticateToken, CardController.createCard);

// PATCH /api/cards/:id/activate - Activate card (must come before /:id to avoid route conflict)
router.patch('/:id/activate', authenticateToken, requireElevatedForMutation, CardController.activateCard);

// PUT /api/cards/:id - Update card
router.put('/:id', authenticateToken, requireElevatedForMutation, CardController.updateCard);

// PATCH /api/cards/:id - Update card (partial update)
router.patch('/:id', authenticateToken, requireElevatedForMutation, CardController.updateCard);

// DELETE /api/cards/:id - Deactivate card
router.delete('/:id', authenticateToken, requireElevatedForMutation, CardController.deleteCard);

module.exports = router;
