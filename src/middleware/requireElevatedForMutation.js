const { USER_ROLES } = require('../constants/roles');

/**
 * After authenticateToken: only admin & accountant may PUT/PATCH/DELETE (and selected POSTs)
 * without going through change-requests. Standard users get 403 + APPROVAL_REQUIRED.
 */
function requireElevatedForMutation(req, res, next) {
  const role = req.user && req.user.role;
  if (!role) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  if (role === USER_ROLES.USER) {
    return res.status(403).json({
      success: false,
      error: 'Standard users cannot edit or delete directly. Submit a request for admin approval.',
      code: 'APPROVAL_REQUIRED',
      hint:
        'Queued for approval (202) with the matching sidebar permission (own rows): PATCH/PUT/POST /api/statements/:id; PUT/PATCH/DELETE /api/purchase-bills/:id; PUT/PATCH/DELETE /api/transactions/:id (daily_transactions); POST /api/transactions/bulk-delete (daily_transactions, admin/accountant); POST /api/fk-emirates/bulk-delete (admin/accountant); PUT/PATCH/DELETE /api/pdc/:id (post_dated_cheques, JSON only). Or POST /api/user/change-requests. Admins: GET /api/admin/change-requests.',
    });
  }
  next();
}

module.exports = { requireElevatedForMutation };
