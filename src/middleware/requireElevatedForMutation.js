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
        'Submit POST /api/user/change-requests with JSON, e.g. payables delete: { "action":"delete", "resourceType":"payables_category", "resourceId":"5" }. Also: receivables_category, transaction (own rows), user_self. Admins: GET /api/admin/change-requests (pendingCount), live: GET /api/admin/change-requests/stream?token=<jwt> (EventSource).',
    });
  }
  next();
}

module.exports = { requireElevatedForMutation };
