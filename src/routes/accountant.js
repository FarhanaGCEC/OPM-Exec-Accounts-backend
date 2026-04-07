const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { authorizeRoles } = require('../middleware/authorizeRoles');
const { USER_ROLES } = require('../constants/roles');
const { dashboard } = require('../controllers/accountantController');

const router = express.Router();

router.get(
  '/dashboard',
  authenticateToken,
  authorizeRoles(USER_ROLES.ADMIN, USER_ROLES.ACCOUNTANT),
  dashboard
);

module.exports = router;
