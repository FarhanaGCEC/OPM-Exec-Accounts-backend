const { USER_ROLES } = require('../constants/roles');

/** Card master (Details): create / update / deactivate — admin only. */
function canManageCreditCards(role) {
  return role === USER_ROLES.ADMIN;
}

module.exports = { canManageCreditCards };
