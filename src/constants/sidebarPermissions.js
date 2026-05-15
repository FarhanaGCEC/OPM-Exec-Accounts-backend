const { USER_ROLES } = require('./roles');

/**
 * Canonical sidebar keys (API / DB) aligned with the app navigation.
 * Frontend should use `key` for routing; `label` is for admin UI display.
 */
const SIDEBAR_MENU_ITEMS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'daily_transactions', label: 'Daily Transactions' },
  { key: 'post_dated_cheques', label: 'Post-Dated Cheques' },
  { key: 'creditors_list', label: 'Creditors List' },
  { key: 'debtors_list', label: 'Debtors List' },
  { key: 'credit_cards', label: 'Credit Cards' },
  { key: 'customer_credit_card_payments', label: 'Customer Credit Card Payments' },
  { key: 'gbp_transactions', label: 'GBP Transactions' },
  { key: 'usd_transactions', label: 'USD Transactions' },
  { key: 'fk_emirates_nbd', label: 'FK EMIRATES NBD' },
  { key: 'user_accounts_management', label: 'User Accounts Management' },
  { key: 'approval_queue', label: 'Approval Queue' },
];

const SIDEBAR_PERMISSION_KEYS = SIDEBAR_MENU_ITEMS.map((i) => i.key);

const KEY_SET = new Set(SIDEBAR_PERMISSION_KEYS);

function allFalsePermissions() {
  const o = {};
  for (const k of SIDEBAR_PERMISSION_KEYS) o[k] = false;
  return o;
}

function allTruePermissions() {
  const o = {};
  for (const k of SIDEBAR_PERMISSION_KEYS) o[k] = true;
  return o;
}

function parseStoredPermissions(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return typeof p === 'object' && p !== null && !Array.isArray(p) ? p : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Keep only known keys; coerce values to boolean.
 */
function normalizePermissionsInput(input) {
  const src = parseStoredPermissions(input) || (typeof input === 'object' && input !== null ? input : {});
  const out = { ...allFalsePermissions() };
  for (const k of SIDEBAR_PERMISSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) {
      out[k] = Boolean(src[k]);
    }
  }
  return out;
}

/**
 * Admin and accountant always see the full menu. Standard users use DB (null = none).
 */
function viewerCreditCardMenuPermissions() {
  const o = allFalsePermissions();
  o.credit_cards = true;
  o.customer_credit_card_payments = true;
  return o;
}

function effectiveSidebarPermissions(role, storedRaw) {
  const r = role || USER_ROLES.USER;
  if (r === USER_ROLES.ADMIN || r === USER_ROLES.ACCOUNTANT) {
    return allTruePermissions();
  }
  if (r === USER_ROLES.VIEWER) {
    return viewerCreditCardMenuPermissions();
  }
  const parsed = parseStoredPermissions(storedRaw);
  if (!parsed) {
    return allFalsePermissions();
  }
  return normalizePermissionsInput(parsed);
}

module.exports = {
  SIDEBAR_MENU_ITEMS,
  SIDEBAR_PERMISSION_KEYS,
  allFalsePermissions,
  allTruePermissions,
  viewerCreditCardMenuPermissions,
  parseStoredPermissions,
  normalizePermissionsInput,
  effectiveSidebarPermissions,
  isValidSidebarPermissionKey: (k) => typeof k === 'string' && KEY_SET.has(k),
};
