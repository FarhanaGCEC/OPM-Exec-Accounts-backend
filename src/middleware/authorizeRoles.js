const { USER_ROLE_VALUES } = require('../constants/roles');

/**
 * Use after authenticateToken. Allows only listed roles (403 if not allowed).
 */
function authorizeRoles(...allowedRoles) {
  const allowed = allowedRoles.length ? allowedRoles : [];
  const invalid = allowed.filter((r) => !USER_ROLE_VALUES.includes(r));
  if (invalid.length) {
    throw new Error(`authorizeRoles: invalid role(s): ${invalid.join(', ')}`);
  }

  return (req, res, next) => {
    if (!req.user || req.user.id == null) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const role = req.user.role;
    if (!role || !allowed.includes(role)) {
      return res.status(403).json({ error: 'Forbidden: role not authorized for this resource' });
    }
    next();
  };
}

module.exports = { authorizeRoles };
