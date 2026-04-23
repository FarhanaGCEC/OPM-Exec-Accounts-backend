// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const typeIs = require('type-is');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const accountantRoutes = require('./routes/accountant');
const userRoutes = require('./routes/user');
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
const dailyBankStatementRoutes = require('./routes/dailyBankStatement');
const { authenticateToken } = require('./middleware/auth');
const { authorizeRoles } = require('./middleware/authorizeRoles');
const { USER_ROLES } = require('./constants/roles');
const adminController = require('./controllers/adminController');
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

function normalizeHttpMethod(req) {
  let m = String(req.method || 'GET').trim().toUpperCase();
  if (!m) m = 'GET';
  return m;
}

// Never run body-parser on GET/HEAD/OPTIONS (tools often send Content-Length + junk body).
// If we call next() before the body is drained, keep-alive can splice bytes into the next request → JSON errors on GET.
const jsonParser = express.json({
  type: (req) => {
    const m = normalizeHttpMethod(req);
    if (['GET', 'HEAD', 'OPTIONS'].includes(m)) return false;
    const ct = req.headers['content-type'] || '';
    return /json|\+json|javascript/i.test(ct);
  },
  // PDC base64 images blow past the library default (~100kb). Set JSON_BODY_LIMIT if you need bigger (e.g. 100mb).
  limit: process.env.JSON_BODY_LIMIT || '50mb',
});
const urlencodedParser = express.urlencoded({
  extended: true,
  type: (req) => /^application\/x-www-form-urlencoded/i.test(String(req.headers['content-type'] || '').split(';')[0].trim())
});

app.use((req, res, next) => {
  const m = normalizeHttpMethod(req);
  if (['GET', 'HEAD', 'OPTIONS'].includes(m)) {
    req.body = req.body || {};
    if (typeIs.hasBody(req)) {
      req.resume();
      let forwarded = false;
      const forward = (err) => {
        if (forwarded) return;
        forwarded = true;
        next(err);
      };
      req.on('end', () => forward());
      req.on('error', forward);
      return;
    }
    return next();
  }
  jsonParser(req, res, (err) => {
    if (err) {
      const msg = err.message != null ? String(err.message) : String(err);
      const tooLarge =
        err.status === 413 ||
        err.statusCode === 413 ||
        err.type === 'entity.too.large' ||
        /entity too large|request entity too large/i.test(msg);
      if (tooLarge) {
        return res.status(413).json({
          success: false,
          error: 'Request body too large',
          details: msg,
          hint:
            'On the API server set JSON_BODY_LIMIT (e.g. JSON_BODY_LIMIT=100mb) and restart. If nginx/Cloudflare sits in front, raise client_max_body_size / upload limit. Prefer multipart field attachment for large images instead of base64 inside JSON.',
        });
      }
      return res.status(400).json({
        success: false,
        error: 'Invalid or malformed JSON body',
        details: msg,
        hint:
          'Send valid JSON (e.g. {"key":"value"}), or for GET/HEAD set Body to none in Postman.',
      });
    }
    next();
  });
});

app.use((req, res, next) => {
  const m = normalizeHttpMethod(req);
  if (['GET', 'HEAD', 'OPTIONS'].includes(m)) {
    return next();
  }
  urlencodedParser(req, res, (err) => {
    if (err) {
      const msg = err.message != null ? String(err.message) : String(err);
      return res.status(400).json({
        success: false,
        error: 'Invalid or malformed form body',
        details: msg,
      });
    }
    next();
  });
});

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to GCEC Account System Backend API' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Authentication routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/accountant', accountantRoutes);
app.use('/api/user', userRoutes);

// Same as GET /api/admin/users — handy if the frontend calls /api/users
app.get(
  '/api/users',
  authenticateToken,
  authorizeRoles(USER_ROLES.ADMIN),
  adminController.listUsers
);

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

// Daily bank statement PDF (standalone, protected)
app.use('/api/daily-bank-statement', dailyBankStatementRoutes);

// Body-parser uses http-errors: status 400, type 'entity.parse.failed' (not always SyntaxError).
app.use((err, req, res, next) => {
  const msg = err && err.message != null ? String(err.message) : '';
  const isBodyParseError =
    err.type === 'entity.parse.failed' ||
    (err.status === 400 &&
      (/json|JSON|syntax|Unexpected token/i.test(msg) || err instanceof SyntaxError));
  if (isBodyParseError) {
    return res.status(400).json({
      success: false,
      error: 'Invalid or malformed request body',
      details: msg,
      hint:
        'Use no body on GET/HEAD. In Postman: Body → none, and remove a leftover Content-Type: application/json if you are not sending JSON.',
    });
  }
  next(err);
});

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    success: false,
    error: err.message || 'Internal server error',
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

