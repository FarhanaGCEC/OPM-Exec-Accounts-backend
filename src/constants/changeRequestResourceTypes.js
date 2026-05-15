/**
 * resourceType values accepted by POST /api/user/change-requests.
 * Standard users: many direct mutations return 403; these types can be submitted here.
 * Auto-queued (202) without a separate POST: PATCH/PUT/POST /api/statements/:id (card_statement),
 * PUT/PATCH/DELETE /api/purchase-bills/:id (purchase_bill, own rows, Credit Cards permission).
 * PUT/PATCH/DELETE /api/credit-card-payments/:id (credit_card_payment, own rows, Customer Credit Card Payments permission).
 * POST /api/credit-card-payments (standard users; admin SSE notification, no approval queue).
 */
const CHANGE_REQUEST_RESOURCE_TYPES = Object.freeze([
  'transaction',
  'user_self',
  'payables_category',
  'receivables_category',
  'card_statement',
  'purchase_bill',
  'credit_card_payment',
  'post_dated_cheque',
]);

module.exports = { CHANGE_REQUEST_RESOURCE_TYPES };
