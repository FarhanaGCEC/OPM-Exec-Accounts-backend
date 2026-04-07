const USER_ROLES = Object.freeze({
  ADMIN: 'admin',
  ACCOUNTANT: 'accountant',
  USER: 'user',
});

const USER_ROLE_VALUES = Object.freeze(Object.values(USER_ROLES));

function isValidUserRole(role) {
  return USER_ROLE_VALUES.includes(role);
}

module.exports = {
  USER_ROLES,
  USER_ROLE_VALUES,
  isValidUserRole,
};
