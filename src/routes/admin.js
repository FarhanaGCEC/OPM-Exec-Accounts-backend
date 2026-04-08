const express = require('express');
const { authenticateToken, authenticateTokenOrQuery } = require('../middleware/auth');
const { authorizeRoles } = require('../middleware/authorizeRoles');
const { USER_ROLES } = require('../constants/roles');
const adminController = require('../controllers/adminController');
const changeRequestAdminController = require('../controllers/changeRequestAdminController');

const router = express.Router();
const adminOnly = [authenticateToken, authorizeRoles(USER_ROLES.ADMIN)];
const adminOnlySse = [authenticateTokenOrQuery, authorizeRoles(USER_ROLES.ADMIN)];

router.get('/users', ...adminOnly, adminController.listUsers);
router.get(
  '/users/:id/sidebar-permissions',
  ...adminOnly,
  adminController.getUserSidebarPermissions
);
router.put(
  '/users/:id/sidebar-permissions',
  ...adminOnly,
  adminController.updateUserSidebarPermissions
);
router.post('/create-user', ...adminOnly, adminController.createUser);
router.put('/update-password/:id', ...adminOnly, adminController.updatePassword);
router.put('/update-role/:id', ...adminOnly, adminController.updateUserRole);
router.delete('/users/:id', ...adminOnly, adminController.deleteUser);
router.get(
  '/change-requests/stream',
  ...adminOnlySse,
  changeRequestAdminController.streamChangeRequestEvents
);
router.get('/change-requests', ...adminOnly, changeRequestAdminController.listChangeRequests);
router.post(
  '/change-requests/:id/approve',
  ...adminOnly,
  changeRequestAdminController.approveChangeRequest
);
router.post(
  '/change-requests/:id/reject',
  ...adminOnly,
  changeRequestAdminController.rejectChangeRequest
);

router.post(
  '/ledger-categories/clear',
  ...adminOnly,
  adminController.clearLedgerCategories
);

module.exports = router;
