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
const statementsRoutes = require('./routes/statements');
const creditCardsRoutes = require('./routes/creditCards');
const cardsRoutes = require('./routes/cards');
const purchaseBillsRoutes = require('./routes/purchaseBills');
const usdTransactionsRoutes = require('./routes/usdTransactions');
const gbpTransactionsRoutes = require('./routes/gbpTransactions');
const fkEmiratesRoutes = require('./routes/fkEmirates');
const { authenticateToken } = require('./middleware/auth');
const { initDatabase } = require('./config/database');

const app = express();
// Parse PORT as integer, default to 3000 if not set or invalid
const PORT = parseInt(process.env.PORT, 10) || 3000;

// CORS configuration
// In development, allow all origins for easier testing
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    // In development, allow all origins
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    
    // In production, check against allowed origins
    const allowedOrigins = [
      process.env.FRONTEND_URL || 'http://localhost:5173',
      'http://localhost:5173',
      'http://127.0.0.1:5173'
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, // Allow cookies/credentials
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  exposedHeaders: ['Authorization'],
  optionsSuccessStatus: 200, // Some legacy browsers (IE11, various SmartTVs) choke on 204
  preflightContinue: false
};

// Middleware
app.use(cors(corsOptions));

// Explicitly handle OPTIONS requests for all routes (additional safety)
app.options('*', cors(corsOptions));

// Request logging middleware (for debugging)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url} - Origin: ${req.headers.origin || 'none'}`);
  next();
});

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

// Credit Cards routes (protected)
app.use('/api/credit-cards', creditCardsRoutes);

// Cards routes (protected) - for card management
app.use('/api/cards', cardsRoutes);

// Statements routes (protected) - must come after cards routes
app.use('/api/statements', statementsRoutes);

// GCEC Purchase Bills routes (protected)
app.use('/api/purchase-bills', purchaseBillsRoutes);

// USD Transactions routes (protected)
app.use('/api/usd-transactions', usdTransactionsRoutes);

// GBP Transactions routes (protected)
app.use('/api/gbp-transactions', gbpTransactionsRoutes);

// FK Emirates Transactions routes (protected) - with currency support (AED, USD, GBP)
app.use('/api/fk-emirates', fkEmiratesRoutes);

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
// const startServer = async () => {
//   try {
//     // Initialize database schema
//     await initDatabase();
    
//     // Start server
//     app.listen(PORT, () => {
//       console.log(`Server is running on port ${PORT}`);
//     });
//   } catch (error) {
//     console.error('Failed to start server:', error);
//     process.exit(1);
//   }
// };
const startServer = async () => {
  try {
    // Initialize database schema
    await initDatabase();
    
    // Validate PORT is a valid number
    if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
      throw new Error(`Invalid PORT: ${PORT}. Must be a number between 1 and 65535`);
    }
    
    // Start server (bind to all interfaces)
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server is running on http://0.0.0.0:${PORT}`);
      console.log(`Server is also accessible on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

