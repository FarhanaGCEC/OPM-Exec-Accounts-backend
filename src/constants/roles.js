const USER_ROLES = Object.freeze({
  ADMIN: 'admin',
  ACCOUNTANT: 'accountant',
  USER: 'user',
  VIEWER: 'viewer',
});

const USER_ROLE_VALUES = Object.freeze(Object.values(USER_ROLES));
const ELEVATED_USER_ROLES = Object.freeze([USER_ROLES.ADMIN, USER_ROLES.ACCOUNTANT]);

function isValidUserRole(role) {
  return USER_ROLE_VALUES.includes(role);
}

function isElevatedUserRole(role) {
  return ELEVATED_USER_ROLES.includes(role);
}

module.exports = {
  USER_ROLES,
  USER_ROLE_VALUES,
  ELEVATED_USER_ROLES,
  isValidUserRole,
  isElevatedUserRole,
};
