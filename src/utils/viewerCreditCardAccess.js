const { USER_ROLES, isElevatedUserRole } = require('../constants/roles');

/** API prefixes where viewer may add / edit / delete (credit cards menu only). */
const VIEWER_CREDIT_CARD_API_PREFIXES = Object.freeze([
  '/api/statements',
  '/api/credit-card-payments',
  '/api/cards',
  '/api/credit-cards',
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

/** Admin, accountant, or viewer on credit-card APIs (direct mutate, no approval queue). */
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
