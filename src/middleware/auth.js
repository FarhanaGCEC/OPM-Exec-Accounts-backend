const jwt = require('jsonwebtoken');
const sessionManager = require('../services/sessionManager');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Middleware to verify JWT token and check inactivity
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  // First verify JWT token is valid
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    // Check if session is still active (not inactive for more than 30 minutes)
    if (!sessionManager.isActive(token)) {
      // Remove expired session
      sessionManager.removeSession(token);
      return res.status(403).json({ 
        error: 'Session expired due to inactivity. Please login again.',
        code: 'SESSION_EXPIRED'
      });
    }

    // Update last activity time for this token
    sessionManager.updateActivity(token);

    req.user = user;
    next();
  });
};

module.exports = {
  authenticateToken,
  JWT_SECRET
};







