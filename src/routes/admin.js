const express = require('express');
const { authenticateToken, authenticateTokenOrQuery } = require('../middleware/auth');
const { authorizeRoles } = require('../middleware/authorizeRoles');
const { USER_ROLES } = require('../constants/roles');
const adminController = require('../controllers/adminController');
const changeRequestAdminController = require('../controllers/changeRequestAdminController');

const router = express.Router();
const adminOnly = [authenticateToken, authorizeRoles(USER_ROLES.ADMIN)];
const adminOnlySse = [authenticateTokenOrQuery, authorizeRoles(USER_ROLES.ADMIN)];
const BOOTSTRAP_SECRET_HEADER = 'x-bootstrap-secret';

function requireBootstrapSecret(req, res, next) {
  const expected = process.env.ADMIN_BOOTSTRAP_SECRET;
  if (!expected || String(expected).trim() === '') {
    return res.status(503).json({
      error: 'Bootstrap user creation is disabled on this server',
      hint: 'Set ADMIN_BOOTSTRAP_SECRET in environment to enable this endpoint',
    });
  }
  const got = String(req.headers[BOOTSTRAP_SECRET_HEADER] || '').trim();
  if (!got || got !== String(expected).trim()) {
    return res.status(401).json({
      error: 'Invalid bootstrap secret',
      hint: `Send header ${BOOTSTRAP_SECRET_HEADER} with the configured ADMIN_BOOTSTRAP_SECRET value`,
    });
  }
  return next();
}

router.get('/users', ...adminOnly, adminController.listUsers);
router.put('/users/:id', ...adminOnly, adminController.updateUser);
router.patch('/users/:id', ...adminOnly, adminController.updateUser);
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
// Emergency/bootstrap path for admin-controlled environments where JWT is unavailable.
// This endpoint is protected by ADMIN_BOOTSTRAP_SECRET (header: x-bootstrap-secret).
router.post('/create-user-bootstrap', requireBootstrapSecret, adminController.createUser);
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
