const { USER_ROLES, isElevatedUserRole } = require('../constants/roles');
const { isViewerCreditCardApiPath } = require('../utils/viewerCreditCardAccess');

/**
 * After authenticateToken: only admin & accountant may PUT/PATCH/DELETE (and selected POSTs)
 * without going through change-requests. Standard users get 403 + APPROVAL_REQUIRED.
 */
function requireElevatedForMutation(req, res, next) {
  const role = req.user && req.user.role;
  if (!role) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  if (!isElevatedUserRole(role)) {
    if (role === USER_ROLES.VIEWER && isViewerCreditCardApiPath(req)) {
      return next();
    }
    const message =
      role === USER_ROLES.USER
        ? 'Standard users cannot edit or delete directly. Submit a request for admin approval.'
        : 'Your role has read-only access and cannot edit or delete.';
    return res.status(403).json({
      success: false,
      error: message,
      code: 'APPROVAL_REQUIRED',
      hint:
        'Queued for approval (202) with the matching sidebar permission (own rows): PATCH/PUT/POST /api/statements/:id; PUT/PATCH/DELETE /api/purchase-bills/:id; PUT/PATCH/DELETE /api/credit-card-payments/:id (customer_credit_card_payments); PUT/PATCH/DELETE /api/transactions/:id (daily_transactions); POST /api/transactions/bulk-delete (daily_transactions, admin/accountant); POST /api/fk-emirates/bulk-delete (admin/accountant); PUT/PATCH/DELETE /api/pdc/:id (post_dated_cheques, JSON only). Standard users may POST /api/credit-card-payments (admin notified). Or POST /api/user/change-requests. Admins: GET /api/admin/change-requests.',
    });
  }
  next();
}

module.exports = { requireElevatedForMutation };
