const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getProfile } = require('../controllers/userProfileController');
const changeRequestUserController = require('../controllers/changeRequestUserController');

const router = express.Router();

router.get('/profile', authenticateToken, getProfile);
router.post(
  '/change-requests',
  authenticateToken,
  changeRequestUserController.submitChangeRequest
);
router.get(
  '/change-requests',
  authenticateToken,
  changeRequestUserController.listMyChangeRequests
);

module.exports = router;
