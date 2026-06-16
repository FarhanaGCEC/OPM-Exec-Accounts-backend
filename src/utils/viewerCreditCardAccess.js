const { USER_ROLES, isElevatedUserRole } = require('../constants/roles');

/** API prefixes for statement/payment mutations (card master /api/cards is admin-only via routes). */
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

function isCreditCardStatementOrPaymentApiPath(req) {
  return req ? isViewerCreditCardApiPath(req) : true;
}

/** Admin, accountant, viewer, or standard user may add/edit on statement/payment APIs. */
function canDirectAddEditCreditCardResources(role, req = null) {
  if (isElevatedUserRole(role)) return true;
  if (role === USER_ROLES.VIEWER && isCreditCardStatementOrPaymentApiPath(req)) return true;
  if (role === USER_ROLES.USER && isCreditCardStatementOrPaymentApiPath(req)) return true;
  return false;
}

/** Delete on statement/payment APIs: admin, accountant, viewer only; standard user needs approval. */
function canDirectDeleteCreditCardResources(role, req = null) {
  if (isElevatedUserRole(role)) return true;
  if (role === USER_ROLES.VIEWER && isCreditCardStatementOrPaymentApiPath(req)) return true;
  return false;
}

/** @deprecated Use canDirectAddEditCreditCardResources or canDirectDeleteCreditCardResources */
function canDirectMutateCreditCardResources(role, req = null) {
  return canDirectAddEditCreditCardResources(role, req);
}

module.exports = {
  VIEWER_CREDIT_CARD_API_PREFIXES,
  isViewerCreditCardApiPath,
  isCreditCardStatementOrPaymentApiPath,
  canDirectAddEditCreditCardResources,
  canDirectDeleteCreditCardResources,
  canDirectMutateCreditCardResources,
};
