/**
 * resourceType values accepted by POST /api/user/change-requests.
 * Standard users: many direct mutations return 403; these types can be submitted here.
 * Auto-queued (202) without a separate POST: PATCH/PUT/POST /api/statements/:id (card_statement),
 * PUT/PATCH/DELETE /api/purchase-bills/:id (purchase_bill, own rows, Credit Cards permission).
 */
const CHANGE_REQUEST_RESOURCE_TYPES = Object.freeze([
  'transaction',
  'user_self',
  'payables_category',
  'receivables_category',
  'card_statement',
  'purchase_bill',
  'post_dated_cheque',
]);

module.exports = { CHANGE_REQUEST_RESOURCE_TYPES };
