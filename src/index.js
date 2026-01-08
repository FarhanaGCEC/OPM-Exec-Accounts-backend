// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const payablesRoutes = require('./routes/payables');
const receivablesRoutes = require('./routes/receivables');
const categoriesRoutes = require('./routes/categories');
const transactionsRoutes = require('./routes/transactions');
const pdcRoutes = require('./routes/pdc');
const creditCardPaymentsRoutes = require('./routes/creditCardPayments');
const analyticsRoutes = require('./routes/analytics');
const accountSummaryRoutes = require('./routes/accountSummary');
const { authenticateToken } = require('./middleware/auth');
const { initDatabase } = require('./config/database');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
// In development, allow all origins for easier testing
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? (process.env.FRONTEND_URL || 'http://localhost:5173')
    : true, // Allow all origins in development
  credentials: true, // Allow cookies/credentials
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Authorization'],
  optionsSuccessStatus: 200 // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to GCEC Account System Backend API' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Authentication routes
app.use('/api/auth', authRoutes);

// Payables categories routes (protected)
app.use('/api/payables', payablesRoutes);

// Receivables categories routes (protected)
app.use('/api/receivables', receivablesRoutes);

// Combined categories route (protected) - returns both payables and receivables
app.use('/api/categories', categoriesRoutes);

// Transactions routes (protected)
app.use('/api/transactions', transactionsRoutes);

// Post-Dated Cheques routes (protected)
app.use('/api/pdc', pdcRoutes);

// Credit Card Payments routes (protected)
app.use('/api/credit-card-payments', creditCardPaymentsRoutes);

// Analytics routes (protected) - for charts and graphs
app.use('/api/analytics', analyticsRoutes);

// Account Summary routes (protected)
app.use('/api/account-summary', accountSummaryRoutes);

// Protected route example
app.get('/api/profile', authenticateToken, (req, res) => {
  res.json({
    message: 'This is a protected route',
    user: req.user
  });
});

// Initialize database and start server
const startServer = async () => {
  try {
    // Initialize database schema
    await initDatabase();
    
    // Start server
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

