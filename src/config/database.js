const mysql = require('mysql2/promise');

// Create MySQL connection pool
const mysqlPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 3306,
  database: process.env.DB_NAME || 'gcec_account_system',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  // connectionLimit: 20,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

// Wrapper to make mysql2 return { rows } like pg for compatibility
const wrapQuery = (executor) => {
  return async (sql, params = []) => {
    const [result] = await executor(sql, params);
    // mysql2: SELECT returns array of rows, INSERT/UPDATE/DELETE returns ResultSetHeader
    const rows = Array.isArray(result) ? result : [];
    const affectedRows = result && typeof result.affectedRows === 'number' ? result.affectedRows : undefined;
    return { rows, affectedRows };
  };
};

// Create pool with pg-compatible query interface
const pool = {
  query: wrapQuery((sql, params) => mysqlPool.query(sql, params)),

  async connect() {
    const conn = await mysqlPool.getConnection();
    return {
      query: wrapQuery((sql, params) => conn.query(sql, params)),
      async beginTransaction() {
        await conn.beginTransaction();
      },
      async commit() {
        await conn.commit();
      },
      async rollback() {
        await conn.rollback();
      },
      release() {
        conn.release();
      }
    };
  }
};

// Test database connection
const testConnection = async () => {
  try {
    await pool.query('SELECT 1');
    console.log('Connected to MySQL database');
    return true;
  } catch (error) {
    console.error('Database connection failed:', error.message);
    if (error.code === 'ER_ACCESS_DENIED_ERROR' || error.code === 'ECONNREFUSED') {
      console.error('\n❌ Database connection failed!');
      console.error('Please check your database credentials in the .env file.');
      console.error('\nRequired environment variables:');
      console.error('  DB_HOST=localhost');
      console.error('  DB_PORT=3306');
      console.error('  DB_NAME=gcec_account_system');
      console.error('  DB_USER=root');
      console.error('  DB_PASSWORD=your_password');
      console.error('\nEnsure MySQL is running and the database exists.\n');
    }
    throw error;
  }
};

// Helper: check if column exists (MySQL)
const columnExists = async (tableName, columnName) => {
  const [rows] = await mysqlPool.query(
    `SELECT 1 FROM information_schema.columns 
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [tableName, columnName]
  );
  return rows && rows.length > 0;
};

// Helper: check if table exists
const tableExists = async (tableName) => {
  const [rows] = await mysqlPool.query(
    `SELECT 1 FROM information_schema.tables 
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [tableName]
  );
  return rows && rows.length > 0;
};

// Fix existing card data
const fixExistingCardData = async () => {
  try {
    const defaultCardsData = [
      { issuingBank: 'Deem Finance', cardHolder: 'Suleman', cardNumber: '5313 9800 0593 7036', expiry: 'Feb-28', billingCycleDays: 21, statementDay: 2, displayOrder: 1 },
      { issuingBank: 'Emirates NBD Etihad', cardHolder: 'Suleman', cardNumber: '4033 3700 5851 2427', expiry: 'Dec-29', billingCycleDays: 25, statementDay: 2, displayOrder: 2 },
      { issuingBank: 'Mashreq Smart Saver', cardHolder: 'Farhana', cardNumber: '4198 6424 7010 9201', expiry: 'Dec-28', billingCycleDays: 27, statementDay: 2, displayOrder: 3 },
      { issuingBank: 'CBD Smiles', cardHolder: 'Farhana', cardNumber: '4451 3530 1729 0890', expiry: 'May-28', billingCycleDays: 22, statementDay: 8, displayOrder: 4 },
      { issuingBank: 'Mashreq Solitaire', cardHolder: 'Suleman', cardNumber: '4198 6924 7111 9303', expiry: 'Dec-26', billingCycleDays: 27, statementDay: 8, displayOrder: 5 },
      { issuingBank: 'Sunil ENBD', cardHolder: 'Sunil', cardNumber: '5127 1710 0443 0639', expiry: 'Nov-28', billingCycleDays: 26, statementDay: 9, displayOrder: 6 },
      { issuingBank: 'EIB Skywards Infinite', cardHolder: 'Farhana', cardNumber: '4421 0985 7539 4017', expiry: 'Dec-30', billingCycleDays: 26, statementDay: 9, displayOrder: 7 },
      { issuingBank: 'ADCB Lulu Card', cardHolder: 'Farhana', cardNumber: '5193 0515 9143 9210', expiry: 'Nov-29', billingCycleDays: 25, statementDay: 10, displayOrder: 8 },
      { issuingBank: 'EIB Black Card', cardHolder: 'Suleman', cardNumber: '4189 6405 0093 0001', expiry: 'Jan-31', billingCycleDays: 25, statementDay: 10, displayOrder: 9 },
      { issuingBank: 'EIB RTA Card', cardHolder: 'Suleman', cardNumber: '4578 2888 1556 6166', expiry: 'Jun-26', billingCycleDays: 25, statementDay: 10, displayOrder: 10 },
      { issuingBank: 'FAB World', cardHolder: 'Suleman', cardNumber: '5492 8403 0052 7218', expiry: 'Sep-30', billingCycleDays: 25, statementDay: 11, displayOrder: 11 },
      { issuingBank: 'FAB Blue', cardHolder: 'Suleman', cardNumber: '4921 8600 4361 8557', expiry: 'Mar-28', billingCycleDays: 25, statementDay: 11, displayOrder: 12 },
      { issuingBank: 'ADCB - Primary', cardHolder: 'Suleman', cardNumber: '5429 3374 1496 6216', expiry: 'Mar-27', billingCycleDays: 25, statementDay: 15, displayOrder: 13 },
      { issuingBank: 'SCB Manhattan', cardHolder: 'Farhana', cardNumber: '4703 4710 0058 4834', expiry: 'Apr-27', billingCycleDays: 25, statementDay: 19, displayOrder: 14 },
      { issuingBank: 'SCB Infinite', cardHolder: 'Suleman', cardNumber: '4444 4710 0068 5148', expiry: 'Jun-26', billingCycleDays: 25, statementDay: 19, displayOrder: 15 },
      { issuingBank: 'FAB World', cardHolder: 'Farhana', cardNumber: '5492 8403 1836 5528', expiry: 'May-30', billingCycleDays: 25, statementDay: 25, displayOrder: 16 },
      { issuingBank: 'SCB Manhattan', cardHolder: 'Suleman', cardNumber: '4703 4710 0005 8821', expiry: 'Sep-28', billingCycleDays: 25, statementDay: 26, displayOrder: 17 }
    ];

    const existingCards = await pool.query(
      `SELECT id, card_holder, card_number, expiry_date, issuing_bank, billing_cycle_days, statement_day, display_order 
       FROM credit_cards_new`
    );

    for (const existingCard of existingCards.rows) {
      const matchingCard = defaultCardsData.find(
        card => card.issuingBank === existingCard.issuing_bank && card.cardHolder === existingCard.card_holder
      );

      if (matchingCard) {
        const currentCardNum = (existingCard.card_number || '').trim().replace(/\s/g, '');
        const expectedCardNum = matchingCard.cardNumber.trim().replace(/\s/g, '');
        const cardNumberNeedsUpdate = currentCardNum.length <= 4 || currentCardNum !== expectedCardNum;
        const expiryNeedsUpdate = !(existingCard.expiry_date || '').match(/^[A-Za-z]{3}-\d{2}$/) ||
          existingCard.expiry_date !== matchingCard.expiry;
        const billingCycleNeedsUpdate = matchingCard.billingCycleDays && existingCard.billing_cycle_days !== matchingCard.billingCycleDays;
        const statementDayNeedsUpdate = matchingCard.statementDay && existingCard.statement_day !== matchingCard.statementDay;
        const displayOrderNeedsUpdate = matchingCard.displayOrder && existingCard.display_order !== matchingCard.displayOrder;

        if (cardNumberNeedsUpdate || expiryNeedsUpdate || billingCycleNeedsUpdate || statementDayNeedsUpdate || displayOrderNeedsUpdate) {
          const updates = [];
          const values = [];

          if (cardNumberNeedsUpdate) { updates.push('card_number = ?'); values.push(matchingCard.cardNumber.trim()); }
          if (expiryNeedsUpdate) { updates.push('expiry_date = ?'); values.push(matchingCard.expiry.trim()); }
          if (billingCycleNeedsUpdate) { updates.push('billing_cycle_days = ?'); values.push(matchingCard.billingCycleDays); }
          if (statementDayNeedsUpdate) { updates.push('statement_day = ?'); values.push(matchingCard.statementDay); }
          if (displayOrderNeedsUpdate) { updates.push('display_order = ?'); values.push(matchingCard.displayOrder); }

          updates.push('updated_at = CURRENT_TIMESTAMP');
          values.push(existingCard.id);

          await pool.query(
            `UPDATE credit_cards_new SET ${updates.join(', ')} WHERE id = ?`,
            values
          );
          console.log(`✅ Fixed card: ${matchingCard.issuingBank} - ${matchingCard.cardHolder}`);
        }
      }
    }
  } catch (error) {
    console.error('Error fixing existing card data:', error.message);
  }
};

// Seed default credit cards for credit_cards_new
const seedDefaultCreditCardsNew = async () => {
  try {
    const existingCards = await pool.query('SELECT COUNT(*) as count FROM credit_cards_new');
    if (parseInt(existingCards.rows[0].count) === 0) {
      const defaultCards = [
        { issuingBank: 'Deem Finance', cardHolder: 'Suleman', cardNumber: '5313 9800 0593 7036', expiry: 'Feb-28', billingCycleDays: 21, statementDay: 2, displayOrder: 1 },
        { issuingBank: 'Emirates NBD Etihad', cardHolder: 'Suleman', cardNumber: '4033 3700 5851 2427', expiry: 'Dec-29', billingCycleDays: 25, statementDay: 2, displayOrder: 2 },
        { issuingBank: 'Mashreq Smart Saver', cardHolder: 'Farhana', cardNumber: '4198 6424 7010 9201', expiry: 'Dec-28', billingCycleDays: 27, statementDay: 2, displayOrder: 3 },
        { issuingBank: 'CBD Smiles', cardHolder: 'Farhana', cardNumber: '4451 3530 1729 0890', expiry: 'May-28', billingCycleDays: 22, statementDay: 8, displayOrder: 4 },
        { issuingBank: 'Mashreq Solitaire', cardHolder: 'Suleman', cardNumber: '4198 6924 7111 9303', expiry: 'Dec-26', billingCycleDays: 27, statementDay: 8, displayOrder: 5 },
        { issuingBank: 'Sunil ENBD', cardHolder: 'Sunil', cardNumber: '5127 1710 0443 0639', expiry: 'Nov-28', billingCycleDays: 26, statementDay: 9, displayOrder: 6 },
        { issuingBank: 'EIB Skywards Infinite', cardHolder: 'Farhana', cardNumber: '4421 0985 7539 4017', expiry: 'Dec-30', billingCycleDays: 26, statementDay: 9, displayOrder: 7 },
        { issuingBank: 'ADCB Lulu Card', cardHolder: 'Farhana', cardNumber: '5193 0515 9143 9210', expiry: 'Nov-29', billingCycleDays: 25, statementDay: 10, displayOrder: 8 },
        { issuingBank: 'EIB Black Card', cardHolder: 'Suleman', cardNumber: '4189 6405 0093 0001', expiry: 'Jan-31', billingCycleDays: 25, statementDay: 10, displayOrder: 9 },
        { issuingBank: 'EIB RTA Card', cardHolder: 'Suleman', cardNumber: '4578 2888 1556 6166', expiry: 'Jun-26', billingCycleDays: 25, statementDay: 10, displayOrder: 10 },
        { issuingBank: 'FAB World', cardHolder: 'Suleman', cardNumber: '5492 8403 0052 7218', expiry: 'Sep-30', billingCycleDays: 25, statementDay: 11, displayOrder: 11 },
        { issuingBank: 'FAB Blue', cardHolder: 'Suleman', cardNumber: '4921 8600 4361 8557', expiry: 'Mar-28', billingCycleDays: 25, statementDay: 11, displayOrder: 12 },
        { issuingBank: 'ADCB - Primary', cardHolder: 'Suleman', cardNumber: '5429 3374 1496 6216', expiry: 'Mar-27', billingCycleDays: 25, statementDay: 15, displayOrder: 13 },
        { issuingBank: 'SCB Manhattan', cardHolder: 'Farhana', cardNumber: '4703 4710 0058 4834', expiry: 'Apr-27', billingCycleDays: 25, statementDay: 19, displayOrder: 14 },
        { issuingBank: 'SCB Infinite', cardHolder: 'Suleman', cardNumber: '4444 4710 0068 5148', expiry: 'Jun-26', billingCycleDays: 25, statementDay: 19, displayOrder: 15 },
        { issuingBank: 'FAB World', cardHolder: 'Farhana', cardNumber: '5492 8403 1836 5528', expiry: 'May-30', billingCycleDays: 25, statementDay: 25, displayOrder: 16 },
        { issuingBank: 'SCB Manhattan', cardHolder: 'Suleman', cardNumber: '4703 4710 0005 8821', expiry: 'Sep-28', billingCycleDays: 25, statementDay: 26, displayOrder: 17 }
      ];

      for (const card of defaultCards) {
        await pool.query(
          `INSERT INTO credit_cards_new 
           (issuing_bank, card_holder, card_number, expiry_date, billing_cycle_days, statement_day, display_order, is_active) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            card.issuingBank,
            card.cardHolder,
            card.cardNumber.trim(),
            card.expiry.trim(),
            card.billingCycleDays !== undefined ? card.billingCycleDays : 25,
            card.statementDay !== undefined ? card.statementDay : 1,
            card.displayOrder !== undefined ? card.displayOrder : 999,
            true
          ]
        );
      }
      console.log(`✅ Seeded ${defaultCards.length} default credit cards (new system)`);
    }
  } catch (error) {
    console.error('Error seeding default credit cards (new system):', error.message);
  }
};

// Seed default credit cards (legacy)
const seedDefaultCreditCards = async () => {
  try {
    const existingSystemCards = await pool.query('SELECT COUNT(*) as count FROM credit_cards WHERE is_system = 1');
    if (parseInt(existingSystemCards.rows[0].count) === 0) {
      const defaultCards = [
        { issuingBank: 'Deem Finance', cardHolder: 'Suleman', cardNumber: '5313 9800 0593 7036', expiry: 'Feb-28', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'Emirates NBD Etihad', cardHolder: 'Suleman', cardNumber: '4033 3700 5851 2427', expiry: 'Dec-29', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'Mashreq Smart Saver', cardHolder: 'Farhana', cardNumber: '4198 6424 7010 9201', expiry: 'Dec-28', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'CBD Smiles', cardHolder: 'Farhana', cardNumber: '4451 3530 1729 0890', expiry: 'May-28', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'Mashreq Solitaire', cardHolder: 'Suleman', cardNumber: '4198 6924 7111 9303', expiry: 'Dec-26', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'Sunil ENBD', cardHolder: 'Sunil', cardNumber: '5127 1710 0443 0639', expiry: 'Nov-28', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'EIB Skywards Infinite', cardHolder: 'Farhana', cardNumber: '4421 0985 7539 4017', expiry: 'Dec-30', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'ADCB Lulu Card', cardHolder: 'Farhana', cardNumber: '5193 0515 9143 9210', expiry: 'Nov-29', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'EIB Black Card', cardHolder: 'Suleman', cardNumber: '4189 6405 0093 0001', expiry: 'Jan-31', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'EIB RTA Card', cardHolder: 'Suleman', cardNumber: '4578 2888 1556 6166', expiry: 'Jun-26', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'FAB World', cardHolder: 'Suleman', cardNumber: '5492 8403 0052 7218', expiry: 'Sep-30', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'FAB Blue', cardHolder: 'Suleman', cardNumber: '4921 8600 4361 8557', expiry: 'Mar-28', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'ADCB - Primary', cardHolder: 'Suleman', cardNumber: '5429 3374 1496 6216', expiry: 'Mar-27', cvv: null, amountLimit: null, isSystem: true, isDefault: true },
        { issuingBank: 'SCB Manhattan', cardHolder: 'Farhana', cardNumber: '4703 4710 0058 4834', expiry: 'Apr-27', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'SCB Infinite', cardHolder: 'Suleman', cardNumber: '4444 4710 0068 5148', expiry: 'Jun-26', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'FAB World', cardHolder: 'Farhana', cardNumber: '5492 8403 1836 5528', expiry: 'May-30', cvv: null, amountLimit: null, isSystem: true, isDefault: false },
        { issuingBank: 'SCB Manhattan', cardHolder: 'Suleman', cardNumber: '4703 4710 0005 8821', expiry: 'Sep-28', cvv: null, amountLimit: null, isSystem: true, isDefault: false }
      ];

      for (const card of defaultCards) {
        await pool.query(
          `INSERT INTO credit_cards (issuing_bank, card_holder, card_number, expiry, cvv, amount_limit, is_system, is_default) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [card.issuingBank, card.cardHolder, card.cardNumber, card.expiry, card.cvv, card.amountLimit, card.isSystem, card.isDefault]
        );
      }
      console.log(`✅ Seeded ${defaultCards.length} default credit cards`);
    }
  } catch (error) {
    console.error('Error seeding default credit cards:', error.message);
  }
};

// Initialize database schema
const initDatabase = async () => {
  try {
    await testConnection();

    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create payables_categories
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payables_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create receivables_categories
    await pool.query(`
      CREATE TABLE IF NOT EXISTS receivables_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create transactions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        date DATE NOT NULL,
        type VARCHAR(10) NOT NULL,
        category_id INT,
        category_type VARCHAR(20),
        payment_type VARCHAR(50) NOT NULL,
        cheque_number VARCHAR(50),
        amount DECIMAL(15, 2) NOT NULL,
        balance DECIMAL(15, 2) NOT NULL,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        remarks TEXT,
        CONSTRAINT chk_type CHECK (type IN ('Debit', 'Credit')),
        CONSTRAINT chk_category_type CHECK (category_type IN ('payable', 'receivable') OR category_type IS NULL),
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)');

    // Create post_dated_cheques
    await pool.query(`
      CREATE TABLE IF NOT EXISTS post_dated_cheques (
        id INT AUTO_INCREMENT PRIMARY KEY,
        cheque_date DATE NOT NULL,
        cheque_number VARCHAR(100) NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        amount DECIMAL(15, 2) NOT NULL,
        cheque_type VARCHAR(50) NOT NULL DEFAULT 'Payment Cheque',
        pdc_type VARCHAR(50) NOT NULL,
        description TEXT,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_pdc_type CHECK (pdc_type IN ('GCEC PDC', 'Customer PDC', 'Custom PDC')),
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_pdc_cheque_date ON post_dated_cheques(cheque_date)');

    // Create credit_cards_new (UUID-based)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_cards_new (
        id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        issuing_bank VARCHAR(255) NOT NULL,
        card_holder VARCHAR(255) NOT NULL,
        card_number VARCHAR(50) NOT NULL,
        expiry_date VARCHAR(10) NOT NULL,
        credit_limit DECIMAL(15, 2),
        billing_cycle_days INT NOT NULL DEFAULT 25,
        statement_day INT NOT NULL DEFAULT 1,
        display_order INT NOT NULL DEFAULT 999,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_statement_day CHECK (statement_day >= 1 AND statement_day <= 31)
      )
    `);
    try { await pool.query('CREATE INDEX idx_credit_cards_new_active ON credit_cards_new(is_active)'); } catch (e) { /* may exist */ }

    // Create credit_card_payments
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_card_payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        payment_date DATE NOT NULL,
        credit_card_id CHAR(36),
        customer_name VARCHAR(255),
        payment_method VARCHAR(50) NOT NULL DEFAULT 'Credit Card',
        amount DECIMAL(15, 2) NOT NULL,
        remarks TEXT,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (credit_card_id) REFERENCES credit_cards_new(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_cc_payment_date ON credit_card_payments(payment_date)');

    // Create credit_cards (legacy)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_cards (
        id INT AUTO_INCREMENT PRIMARY KEY,
        issuing_bank VARCHAR(255) NOT NULL,
        card_holder VARCHAR(255) NOT NULL,
        card_number VARCHAR(50) NOT NULL,
        expiry VARCHAR(10) NOT NULL,
        cvv VARCHAR(10),
        amount_limit DECIMAL(15, 2),
        is_system TINYINT(1) DEFAULT 0,
        is_default TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_credit_cards_is_system ON credit_cards(is_system)');

    // Create credit_card_statements
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_card_statements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        card_id INT NOT NULL,
        statement_month INT NOT NULL,
        statement_year INT NOT NULL,
        statement_date DATE NOT NULL,
        due_date DATE NOT NULL,
        due_month VARCHAR(50),
        total_payment_due DECIMAL(15, 2) NOT NULL DEFAULT 0,
        paid DECIMAL(15, 2) NOT NULL DEFAULT 0,
        epp DECIMAL(15, 2) NOT NULL DEFAULT 0,
        amount_pending DECIMAL(15, 2) NOT NULL DEFAULT 0,
        status VARCHAR(10) NOT NULL DEFAULT 'DUE',
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_card_month_year (card_id, statement_month, statement_year),
        CONSTRAINT chk_statement_month CHECK (statement_month >= 1 AND statement_month <= 12),
        CONSTRAINT chk_status CHECK (status IN ('PAID', 'DUE')),
        FOREIGN KEY (card_id) REFERENCES credit_cards(id) ON DELETE CASCADE
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_cc_statements_card_month_year ON credit_card_statements(card_id, statement_month, statement_year)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_cc_statements_month_year ON credit_card_statements(statement_month, statement_year)');

    await seedDefaultCreditCards();

    // Create card_statements (new system)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS card_statements (
        id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        credit_card_id CHAR(36) NOT NULL,
        statement_month VARCHAR(7) NOT NULL,
        statement_date DATE NOT NULL,
        due_date DATE NOT NULL,
        days INT NOT NULL,
        due_month VARCHAR(50),
        total_due DECIMAL(15, 2) NOT NULL DEFAULT 0,
        paid_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
        pending_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
        epp_balance DECIMAL(15, 2) NOT NULL DEFAULT 0,
        balance_transfer DECIMAL(15, 2) NOT NULL DEFAULT 0,
        payment_status VARCHAR(10) NOT NULL DEFAULT 'PARTIAL',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_card_month (credit_card_id, statement_month),
        CONSTRAINT chk_statement_month_format CHECK (statement_month REGEXP '^[0-9]{4}-[0-9]{2}$'),
        CONSTRAINT chk_payment_status CHECK (payment_status IN ('PAID', 'PARTIAL', 'OVERDUE')),
        FOREIGN KEY (credit_card_id) REFERENCES credit_cards_new(id) ON DELETE CASCADE
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_card_statements_month ON card_statements(statement_month)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_card_statements_card_month ON card_statements(credit_card_id, statement_month)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_card_statements_status ON card_statements(payment_status)');

    await seedDefaultCreditCardsNew();
    await fixExistingCardData();

    // Create purchase_bills
    await pool.query(`
      CREATE TABLE IF NOT EXISTS purchase_bills (
        id INT AUTO_INCREMENT PRIMARY KEY,
        bill_date DATE NOT NULL,
        invoice_number VARCHAR(255),
        vendor_name VARCHAR(255),
        bill_number VARCHAR(255),
        payment_method VARCHAR(50) NOT NULL DEFAULT 'Credit Card',
        amount DECIMAL(15, 2) NOT NULL,
        description TEXT,
        payment_status VARCHAR(50) NOT NULL DEFAULT 'Pending',
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // Create usd_transactions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usd_transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account_number VARCHAR(50),
        date DATE NOT NULL,
        description VARCHAR(255) NOT NULL,
        details VARCHAR(255),
        debit DECIMAL(15, 2) DEFAULT 0,
        bank_charges DECIMAL(15, 2) DEFAULT 0,
        credit DECIMAL(15, 2) DEFAULT 0,
        balance DECIMAL(15, 2) NOT NULL,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_usd_transactions_date ON usd_transactions(date)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_usd_transactions_account ON usd_transactions(account_number)');

    // Create gbp_transactions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gbp_transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account_number VARCHAR(50),
        date DATE NOT NULL,
        description VARCHAR(255) NOT NULL,
        details VARCHAR(255),
        debit DECIMAL(15, 2) DEFAULT 0,
        bank_charges DECIMAL(15, 2) DEFAULT 0,
        credit DECIMAL(15, 2) DEFAULT 0,
        balance DECIMAL(15, 2) NOT NULL,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_gbp_transactions_date ON gbp_transactions(date)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_gbp_transactions_account ON gbp_transactions(account_number)');

    // Create emirates_transactions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS emirates_transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account_number VARCHAR(50),
        date DATE NOT NULL,
        description VARCHAR(255) NOT NULL,
        details VARCHAR(255),
        currency VARCHAR(3) NOT NULL DEFAULT 'AED',
        debit DECIMAL(15, 2) DEFAULT 0,
        bank_charges DECIMAL(15, 2) DEFAULT 0,
        credit DECIMAL(15, 2) DEFAULT 0,
        balance DECIMAL(15, 2) NOT NULL,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_currency CHECK (currency IN ('AED', 'USD', 'GBP')),
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_emirates_transactions_date ON emirates_transactions(date)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_emirates_transactions_account ON emirates_transactions(account_number)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_emirates_transactions_currency ON emirates_transactions(currency)');

    console.log('✅ Database schema initialized');
  } catch (error) {
    console.error('Error initializing database:', error.message);
    throw error;
  }
};

module.exports = {
  pool,
  initDatabase
};
