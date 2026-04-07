const User = require('../models/User');

async function getProfile(req, res) {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    console.error('getProfile:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getProfile };
