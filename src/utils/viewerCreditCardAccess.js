const { USER_ROLES, isElevatedUserRole } = require('../constants/roles');

/** API prefixes where viewer may add / edit / delete (statements & payments only; card master is admin-only). */
const VIEWER_CREDIT_CARD_API_PREFIXES = Object.freeze([
  '/api/statements',
  '/api/credit-card-payments',
]);

function requestPath(req) {
  const raw = req.originalUrl || req.url || '';
  return String(raw).split('?')[0];
}

function isViewerCreditCardApiPath(req) {
  const path = requestPath(req);
  return VIEWER_CREDIT_CARD_API_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}

/** Admin or accountant for statements/payments; viewer only on statement/payment APIs. Card master (/api/cards) is admin-only via routes. */
function canDirectMutateCreditCardResources(role, req = null) {
  if (isElevatedUserRole(role)) return true;
  if (role === USER_ROLES.VIEWER && req && isViewerCreditCardApiPath(req)) return true;
  if (role === USER_ROLES.VIEWER && !req) return true;
  return false;
}

module.exports = {
  VIEWER_CREDIT_CARD_API_PREFIXES,
  isViewerCreditCardApiPath,
  canDirectMutateCreditCardResources,
};
