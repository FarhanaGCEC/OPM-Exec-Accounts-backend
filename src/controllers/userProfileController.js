const User = require('../models/User');
const { effectiveSidebarPermissions } = require('../constants/sidebarPermissions');
const { USER_ROLES } = require('../constants/roles');
const { CHANGE_REQUEST_RESOURCE_TYPES } = require('../constants/changeRequestResourceTypes');

async function getProfile(req, res) {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const payload = {
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.createdAt,
        sidebarPermissions: effectiveSidebarPermissions(
          user.role,
          user.sidebarPermissionsStored
        ),
      },
    };
    if (user.role === USER_ROLES.USER) {
      payload.user.approvalPolicy = {
        directMutationsBlocked: true,
        changeRequestResourceTypes: [...CHANGE_REQUEST_RESOURCE_TYPES],
        cardStatementQueuedViaPatch:
          'PATCH/PUT/POST /api/statements/:id (JSON, with Credit Cards permission) returns 202 and creates a pending change request; data is unchanged until admin approves.',
      };
    }
    return res.json(payload);
  } catch (error) {
    console.error('getProfile:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getProfile };
