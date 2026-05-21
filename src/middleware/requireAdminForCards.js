const { canManageCreditCards } = require('../utils/creditCardPermissions');

/**
 * After authenticateToken: only admin may mutate card master (/api/cards, /api/credit-cards).
 */
function requireAdminForCards(req, res, next) {
  const role = req.user && req.user.role;
  if (!role) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  if (!canManageCreditCards(role)) {
    return res.status(403).json({
      success: false,
      error: 'Only administrators can create or edit credit cards.',
      code: 'ADMIN_ONLY',
    });
  }
  next();
}

module.exports = { requireAdminForCards };
