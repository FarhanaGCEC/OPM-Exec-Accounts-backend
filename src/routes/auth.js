const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { USER_ROLES } = require('../constants/roles');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// Opening /api/auth/login in the browser uses GET → was 404 because only POST exists.
router.get('/login', (req, res) => {
  res.setHeader('Allow', 'POST');
  return res.status(405).json({
    error: 'Method not allowed',
    message: 'Login must use POST, not GET.',
    hint: 'POST /api/auth/login with JSON body: { "username": "...", "password": "..." } and Content-Type: application/json',
  });
});

router.get('/signup', (req, res) => {
  res.setHeader('Allow', 'POST');
  return res.status(405).json({
    error: 'Method not allowed',
    message: 'Signup must use POST, not GET.',
    hint: 'POST /api/auth/signup with JSON body: { "username": "...", "password": "..." } and Content-Type: application/json',
  });
});

// Public signup — new accounts are always role "user". Admin/accountant accounts are created via POST /api/admin/create-user only.
router.post('/signup', async (req, res) => {
  try {
    const username = req.body.username || req.body.Username;
    const password = req.body.password || req.body.Password;

    if (!username || !password) {
      return res.status(400).json({
        error: 'Username and password are required',
        hint: 'Use lowercase keys: "username" and "password"',
      });
    }
    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters long' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create(username, hashedPassword, USER_ROLES.USER);

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    const sessionManager = require('../services/sessionManager');
    sessionManager.updateActivity(token);

    return res.status(201).json({
      message: 'User created successfully',
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
    });
  } catch (error) {
    if (error.message === 'Username already exists') {
      return res.status(409).json({ error: error.message });
    }
    console.error('signup:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Login route
router.post('/login', async (req, res) => {
  try {
    // Handle case-insensitive field names
    const username = req.body.username || req.body.Username;
    const password = req.body.password || req.body.Password;

    // Validation
    if (!username || !password) {
      return res.status(400).json({ 
        error: 'Username and password are required',
        hint: 'Make sure to use lowercase: "username" and "password"'
      });
    }

    // Find user
    const user = await User.findByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    const sessionManager = require('../services/sessionManager');
    sessionManager.updateActivity(token);

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout route - clears session activity tracking
router.post('/logout', (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (token) {
      // Remove session from tracking
      const sessionManager = require('../services/sessionManager');
      sessionManager.removeSession(token);
    }

    res.json({
      message: 'Logout successful'
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

