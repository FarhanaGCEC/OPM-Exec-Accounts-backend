const jwt = require('jsonwebtoken');
const sessionManager = require('../services/sessionManager');
const User = require('../models/User');
const { USER_ROLES } = require('../constants/roles');
const { isViewerCreditCardApiPath } = require('../utils/viewerCreditCardAccess');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

function isReadOnlyMethod(method) {
  const m = String(method || 'GET').trim().toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}

function enforceViewerReadOnly(req, res) {
  const role = req.user && req.user.role;
  if (role === USER_ROLES.VIEWER && !isReadOnlyMethod(req.method)) {
    if (isViewerCreditCardApiPath(req)) {
      return true;
    }
    res.status(403).json({
      success: false,
      error:
        'Viewer role is read-only outside Credit Cards. Statements, payments, and card details can be changed.',
      code: 'VIEWER_READ_ONLY',
    });
    return false;
  }
  return true;
}

function tokenFromRequest(req) {
  const authHeader = req.headers['authorization'];
  const bearer = authHeader && authHeader.split(' ')[1];
  if (bearer) return bearer;
  if (req.query && req.query.token) return String(req.query.token).trim();
  return null;
}

// Middleware to verify JWT token and check inactivity
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (!sessionManager.isActive(token)) {
      sessionManager.removeSession(token);
      return res.status(401).json({
        error: 'Session expired due to inactivity. Please login again.',
        code: 'SESSION_EXPIRED',
      });
    }

    sessionManager.updateActivity(token);

    const id = payload.id != null ? payload.id : payload.sub;
    if (id == null || id === '') {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    (async () => {
      try {
        const dbUser = await User.findById(id);
        if (!dbUser) {
          return res.status(401).json({ error: 'User not found' });
        }
        req.user = {
          id: dbUser.id,
          username: dbUser.username,
          role: dbUser.role || 'user',
        };
        if (!enforceViewerReadOnly(req, res)) {
          return;
        }
        next();
      } catch (e) {
        console.error('authenticateToken:', e);
        return res.status(500).json({ error: 'Internal server error' });
      }
    })();
  });
};

/**
 * Bearer header OR ?token=… (EventSource cannot set Authorization; use only for SSE route).
 */
const authenticateTokenOrQuery = (req, res, next) => {
  const token = tokenFromRequest(req);
  if (!token) {
    return res.status(401).json({
      error: 'Access token required',
      hint: 'Use Authorization: Bearer <jwt> or ?token=<jwt> for EventSource',
    });
  }
  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (!sessionManager.isActive(token)) {
      sessionManager.removeSession(token);
      return res.status(401).json({
        error: 'Session expired due to inactivity. Please login again.',
        code: 'SESSION_EXPIRED',
      });
    }
    sessionManager.updateActivity(token);
    const id = payload.id != null ? payload.id : payload.sub;
    if (id == null || id === '') {
      return res.status(401).json({ error: 'Invalid token payload' });
    }
    (async () => {
      try {
        const dbUser = await User.findById(id);
        if (!dbUser) {
          return res.status(401).json({ error: 'User not found' });
        }
        req.user = {
          id: dbUser.id,
          username: dbUser.username,
          role: dbUser.role || 'user',
        };
        if (!enforceViewerReadOnly(req, res)) {
          return;
        }
        next();
      } catch (e) {
        console.error('authenticateTokenOrQuery:', e);
        return res.status(500).json({ error: 'Internal server error' });
      }
    })();
  });
};

module.exports = {
  authenticateToken,
  authenticateTokenOrQuery,
  JWT_SECRET,
  tokenFromRequest,
};







