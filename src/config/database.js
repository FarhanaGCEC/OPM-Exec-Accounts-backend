const mysql = require('mysql2/promise');

/** Host only — not a URL (wrong: http://1.2.3.4/, right: 1.2.3.4 or mysql.example.com). */
function normalizeDbHost(raw) {
  if (raw == null || String(raw).trim() === '') return 'localhost';
  let h = String(raw).trim();
  h = h.replace(/^https?:\/\//i, '');
  const pathStart = h.indexOf('/');
  if (pathStart !== -1) h = h.slice(0, pathStart);
  h = h.replace(/\/+$/, '').trim();
  return h || 'localhost';
}

const resolvedDbHost = normalizeDbHost(process.env.DB_HOST);
const resolvedDbPort = parseInt(process.env.DB_PORT, 10) || 3306;
const DB_SESSION_TIMEZONE = process.env.DB_SESSION_TIMEZONE || '+04:00';
const SESSION_TZ_INITIALIZED = Symbol('sessionTimezoneInitialized');

// Create MySQL connection pool
const mysqlPool = mysql.createPool({
  host: resolvedDbHost,
  port: resolvedDbPort,
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
    let insertId;
    if (result != null && result.insertId != null && result.insertId !== '') {
      const n =
        typeof result.insertId === 'bigint'
          ? Number(result.insertId)
          : typeof result.insertId === 'string'
            ? parseInt(result.insertId, 10)
            : result.insertId;
      insertId = Number.isFinite(n) && n > 0 ? n : undefined;
    }
    return { rows, affectedRows, insertId };
  };
};

async function ensureConnectionTimezone(conn) {
  if (!conn) return;
  if (conn[SESSION_TZ_INITIALIZED]) return;
  await conn.query('SET time_zone = ?', [DB_SESSION_TIMEZONE]);
  conn[SESSION_TZ_INITIALIZED] = true;
}

// Create pool with pg-compatible query interface
const pool = {
  async query(sql, params = []) {
    const conn = await mysqlPool.getConnection();
    try {
      await ensureConnectionTimezone(conn);
      const [result] = await conn.query(sql, params);
      // Keep return shape compatible with previous wrapper.
      const rows = Array.isArray(result) ? result : [];
      const affectedRows =
        result && typeof result.affectedRows === 'number' ? result.affectedRows : undefined;
      let insertId;
      if (result != null && result.insertId != null && result.insertId !== '') {
        const n =
          typeof result.insertId === 'bigint'
            ? Number(result.insertId)
            : typeof result.insertId === 'string'
              ? parseInt(result.insertId, 10)
              : result.insertId;
        insertId = Number.isFinite(n) && n > 0 ? n : undefined;
      }
      return { rows, affectedRows, insertId };
    } finally {
      conn.release();
    }
  },

  async connect() {
    const conn = await mysqlPool.getConnection();
    await ensureConnectionTimezone(conn);
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
    if (
      error.code === 'ER_ACCESS_DENIED_ERROR' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ENOTFOUND'
    ) {
      console.error('\n❌ Database connection failed!');
      console.error('Please check your database credentials in the .env file.');
      console.error(
        `\nTarget: mysql://${process.env.DB_USER || 'root'}@${resolvedDbHost}:${resolvedDbPort}/${process.env.DB_NAME || 'gcec_account_system'}`
      );
      if (error.code === 'ER_ACCESS_DENIED_ERROR') {
        console.error(
          "\nAccess denied: wrong DB_USER / DB_PASSWORD, or this user is not allowed to connect from your machine."
        );
        console.error(
          "- If the database runs on another server (VPS/cPanel): set DB_HOST to that host/IP and in MySQL add your client IP in Remote MySQL (or use an SSH tunnel and then DB_HOST=127.0.0.1)."
        );
        console.error(
          "- If MySQL is on another machine, use that host as DB_HOST (not localhost unless you use an SSH tunnel to forward port 3306)."
        );
      }
      if (error.code === 'ENOTFOUND' && process.env.DB_HOST && /https?:\/\//i.test(process.env.DB_HOST)) {
        console.error('\nTip: DB_HOST must be a hostname or IP only, not a URL.');
        console.error('  Wrong: DB_HOST=http://165.245.188.54/');
        console.error('  Right: DB_HOST=165.245.188.54');
      }
      if (error.code === 'ECONNREFUSED') {
        console.error(
          '\nTip: ECONNREFUSED usually means nothing is listening on that host:port (firewall, MySQL bound to 127.0.0.1 only, or use SSH tunnel / VPN).'
        );
      }
      console.error('\nRequired environment variables:');
      console.error('  DB_HOST=hostname_or_ip   (no http://, no trailing path)');
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

// Helper: ensure index exists (MySQL < 8.0.12 has no CREATE INDEX IF NOT EXISTS)
const indexExists = async (tableName, indexName) => {
  const [rows] = await mysqlPool.query(
    `SELECT 1 FROM information_schema.statistics 
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [tableName, indexName]
  );
  return rows && rows.length > 0;
};




const ensureIndex = async (tableName, indexName, columnsSql) => {
  if (await indexExists(tableName, indexName)) return;
  await pool.query(
    `CREATE INDEX \`${indexName}\` ON \`${tableName}\` (${columnsSql})`
  );
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
      const currentCardNum = (existingCard.card_number || '').trim().replace(/\s/g, '');
      const matchingCard = defaultCardsData.find((card) => {
        const expected = card.cardNumber.trim().replace(/\s/g, '');
        return expected === currentCardNum;
      });

      if (matchingCard) {
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
        role ENUM('admin', 'accountant', 'user', 'viewer') NOT NULL DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    if (await tableExists('users')) {
      if (!(await columnExists('users', 'role'))) {
        await pool.query(`
          ALTER TABLE users
          ADD COLUMN role ENUM('admin', 'accountant', 'user', 'viewer') NOT NULL DEFAULT 'user'
        `);
      } else {
        // Keep existing databases in sync with new supported role values.
        await pool.query(`
          ALTER TABLE users
          MODIFY COLUMN role ENUM('admin', 'accountant', 'user', 'viewer') NOT NULL DEFAULT 'user'
        `);
      }
      if (!(await columnExists('users', 'sidebar_permissions'))) {
        await pool.query(`
          ALTER TABLE users
          ADD COLUMN sidebar_permissions JSON NULL
        `);
      }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS change_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        requester_id INT NULL,
        action ENUM('edit', 'delete') NOT NULL,
        resource_type VARCHAR(64) NOT NULL,
        resource_id VARCHAR(64) NOT NULL,
        payload JSON NULL,
        request_note TEXT NULL,
        status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        reviewed_by INT NULL,
        reviewed_at TIMESTAMP NULL,
        review_note TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_change_requests_requester FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_change_requests_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await ensureIndex('change_requests', 'idx_change_requests_status', '`status`');
    await ensureIndex('change_requests', 'idx_change_requests_requester', 'requester_id');
    await ensureIndex(
      'change_requests',
      'idx_change_requests_status_created',
      '`status`, created_at DESC'
    );

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
        transaction_time TIME NOT NULL DEFAULT '00:00:00',
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
    if (await tableExists('transactions')) {
      if (!(await columnExists('transactions', 'transaction_time'))) {
        await pool.query(
          "ALTER TABLE transactions ADD COLUMN transaction_time TIME NOT NULL DEFAULT '00:00:00' AFTER `date`"
        );
      }
      if (!(await columnExists('transactions', 'attachment_name'))) {
        await pool.query(
          'ALTER TABLE transactions ADD COLUMN attachment_name VARCHAR(512) NULL'
        );
      }
      if (!(await columnExists('transactions', 'attachment_url'))) {
        await pool.query('ALTER TABLE transactions ADD COLUMN attachment_url TEXT NULL');
      }
      if (!(await columnExists('transactions', 'attachment_cloudinary_public_id'))) {
        await pool.query(
          'ALTER TABLE transactions ADD COLUMN attachment_cloudinary_public_id VARCHAR(512) NULL'
        );
      }
      if (!(await columnExists('transactions', 'attachment_resource_type'))) {
        await pool.query(
          "ALTER TABLE transactions ADD COLUMN attachment_resource_type VARCHAR(16) NULL"
        );
      }
    }
    await ensureIndex('transactions', 'idx_transactions_date', '`date`');
    await ensureIndex('transactions', 'idx_transactions_date_time_id', '`date`, transaction_time, id');

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
        daily_ledger_approved TINYINT(1) NOT NULL DEFAULT 0,
        daily_ledger_approved_at TIMESTAMP NULL,
        attachment_name VARCHAR(512) NULL,
        attachment_url TEXT NULL,
        attachment_cloudinary_public_id VARCHAR(512) NULL,
        attachment_resource_type VARCHAR(16) NULL,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_pdc_type CHECK (pdc_type IN ('GCEC PDC', 'Customer PDC', 'Custom PDC')),
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await ensureIndex('post_dated_cheques', 'idx_pdc_cheque_date', 'cheque_date');

    if (await tableExists('post_dated_cheques')) {
      if (!(await columnExists('post_dated_cheques', 'attachment_name'))) {
        await pool.query(
          'ALTER TABLE post_dated_cheques ADD COLUMN attachment_name VARCHAR(512) NULL'
        );
      }
      if (!(await columnExists('post_dated_cheques', 'attachment_url'))) {
        await pool.query('ALTER TABLE post_dated_cheques ADD COLUMN attachment_url TEXT NULL');
      }
      if (!(await columnExists('post_dated_cheques', 'attachment_cloudinary_public_id'))) {
        await pool.query(
          'ALTER TABLE post_dated_cheques ADD COLUMN attachment_cloudinary_public_id VARCHAR(512) NULL'
        );
      }
      if (!(await columnExists('post_dated_cheques', 'attachment_resource_type'))) {
        await pool.query(
          "ALTER TABLE post_dated_cheques ADD COLUMN attachment_resource_type VARCHAR(16) NULL"
        );
      }
      if (!(await columnExists('post_dated_cheques', 'daily_ledger_approved'))) {
        await pool.query(
          'ALTER TABLE post_dated_cheques ADD COLUMN daily_ledger_approved TINYINT(1) NOT NULL DEFAULT 0'
        );
      }
      if (!(await columnExists('post_dated_cheques', 'daily_ledger_approved_at'))) {
        await pool.query(
          'ALTER TABLE post_dated_cheques ADD COLUMN daily_ledger_approved_at TIMESTAMP NULL'
        );
      }
    }

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
    await ensureIndex('credit_cards_new', 'idx_credit_cards_new_active', 'is_active');

    // Older DBs may predate statement_day / display_order; /api/cards ORDER BY needs them.
    if (await tableExists('credit_cards_new')) {
      if (!(await columnExists('credit_cards_new', 'statement_day'))) {
        await pool.query(
          'ALTER TABLE credit_cards_new ADD COLUMN statement_day INT NOT NULL DEFAULT 1'
        );
      }
      if (!(await columnExists('credit_cards_new', 'display_order'))) {
        await pool.query(
          'ALTER TABLE credit_cards_new ADD COLUMN display_order INT NOT NULL DEFAULT 999'
        );
      }
    }

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
        paid_against VARCHAR(255),
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (credit_card_id) REFERENCES credit_cards_new(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    if (await tableExists('credit_card_payments')) {
      if (!(await columnExists('credit_card_payments', 'paid_against'))) {
        await pool.query(
          'ALTER TABLE credit_card_payments ADD COLUMN paid_against VARCHAR(255) NULL'
        );
      }
    }
    await ensureIndex('credit_card_payments', 'idx_cc_payment_date', 'payment_date');

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
    await ensureIndex('credit_cards', 'idx_credit_cards_is_system', 'is_system');

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
    await ensureIndex('credit_card_statements', 'idx_cc_statements_card_month_year', 'card_id, statement_month, statement_year');
    await ensureIndex('credit_card_statements', 'idx_cc_statements_month_year', 'statement_month, statement_year');

    // Legacy credit_cards / credit_card_statements are not auto-seeded — only credit_cards_new (card master).

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
        min_payment_due DECIMAL(15, 2) NOT NULL DEFAULT 0,
        payment_status VARCHAR(10) NOT NULL DEFAULT 'PARTIAL',
        attachment_name VARCHAR(512) NULL,
        attachment_storage_key VARCHAR(255) NULL,
        attachment_url TEXT NULL,
        attachment_cloudinary_public_id VARCHAR(512) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_card_month (credit_card_id, statement_month),
        CONSTRAINT chk_statement_month_format CHECK (statement_month REGEXP '^[0-9]{4}-[0-9]{2}$'),
        CONSTRAINT chk_payment_status CHECK (payment_status IN ('PAID', 'PARTIAL', 'OVERDUE')),
        FOREIGN KEY (credit_card_id) REFERENCES credit_cards_new(id) ON DELETE CASCADE
      )
    `);
    await ensureIndex('card_statements', 'idx_card_statements_month', 'statement_month');
    await ensureIndex('card_statements', 'idx_card_statements_card_month', 'credit_card_id, statement_month');
    await ensureIndex('card_statements', 'idx_card_statements_status', 'payment_status');

    if (await tableExists('card_statements')) {
      if (!(await columnExists('card_statements', 'attachment_name'))) {
        await pool.query(
          'ALTER TABLE card_statements ADD COLUMN attachment_name VARCHAR(512) NULL'
        );
      }
      if (!(await columnExists('card_statements', 'attachment_storage_key'))) {
        await pool.query(
          'ALTER TABLE card_statements ADD COLUMN attachment_storage_key VARCHAR(255) NULL'
        );
      }
      if (!(await columnExists('card_statements', 'attachment_url'))) {
        await pool.query('ALTER TABLE card_statements ADD COLUMN attachment_url TEXT NULL');
      }
      if (!(await columnExists('card_statements', 'attachment_cloudinary_public_id'))) {
        await pool.query(
          'ALTER TABLE card_statements ADD COLUMN attachment_cloudinary_public_id VARCHAR(512) NULL'
        );
      }
      if (!(await columnExists('card_statements', 'min_payment_due'))) {
        await pool.query(
          'ALTER TABLE card_statements ADD COLUMN min_payment_due DECIMAL(15, 2) NOT NULL DEFAULT 0'
        );
      }
    }

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
        paid_against VARCHAR(255),
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
    if (await tableExists('purchase_bills')) {
      if (!(await columnExists('purchase_bills', 'paid_against'))) {
        await pool.query(
          'ALTER TABLE purchase_bills ADD COLUMN paid_against VARCHAR(255) NULL'
        );
      }
    }

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
    await ensureIndex('usd_transactions', 'idx_usd_transactions_date', '`date`');
    await ensureIndex('usd_transactions', 'idx_usd_transactions_account', 'account_number');
    await ensureIndex('usd_transactions', 'idx_usd_transactions_date', '`date`');
    await ensureIndex('usd_transactions', 'idx_usd_transactions_account', 'account_number');

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
    await ensureIndex('gbp_transactions', 'idx_gbp_transactions_date', '`date`');
    await ensureIndex('gbp_transactions', 'idx_gbp_transactions_account', 'account_number');
    await ensureIndex('gbp_transactions', 'idx_gbp_transactions_date', '`date`');
    await ensureIndex('gbp_transactions', 'idx_gbp_transactions_account', 'account_number');

    // Create daily_bank_statements (singleton row: one active PDF only)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_bank_statements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        currency ENUM('AED', 'USD', 'GBP') NOT NULL DEFAULT 'AED',
        original_filename VARCHAR(512) NOT NULL,
        stored_filename VARCHAR(512) NOT NULL,
        file_path VARCHAR(1024) NOT NULL,
        mime_type VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
        file_size BIGINT NULL,
        statement_total_debit_amount DECIMAL(15, 2) NULL,
        statement_total_credit_amount DECIMAL(15, 2) NULL,
        statement_ledger_balance DECIMAL(15, 2) NULL,
        uploaded_by INT NULL,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_daily_bank_statement_currency (currency),
        CONSTRAINT fk_daily_bank_statements_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    if (await tableExists('daily_bank_statements')) {
      if (!(await columnExists('daily_bank_statements', 'currency'))) {
        await pool.query(
          `ALTER TABLE daily_bank_statements
           ADD COLUMN currency ENUM('AED', 'USD', 'GBP') NOT NULL DEFAULT 'AED'`
        );
      }
      if (!(await columnExists('daily_bank_statements', 'original_filename'))) {
        await pool.query(
          'ALTER TABLE daily_bank_statements ADD COLUMN original_filename VARCHAR(512) NOT NULL DEFAULT "daily-bank-statement.pdf"'
        );
      }
      if (!(await columnExists('daily_bank_statements', 'stored_filename'))) {
        await pool.query(
          'ALTER TABLE daily_bank_statements ADD COLUMN stored_filename VARCHAR(512) NOT NULL DEFAULT "daily-bank-statement.pdf"'
        );
      }
      if (!(await columnExists('daily_bank_statements', 'file_path'))) {
        await pool.query(
          'ALTER TABLE daily_bank_statements ADD COLUMN file_path VARCHAR(1024) NOT NULL DEFAULT ""'
        );
      }
      if (!(await columnExists('daily_bank_statements', 'mime_type'))) {
        await pool.query(
          'ALTER TABLE daily_bank_statements ADD COLUMN mime_type VARCHAR(100) NOT NULL DEFAULT "application/pdf"'
        );
      }
      if (!(await columnExists('daily_bank_statements', 'file_size'))) {
        await pool.query(
          'ALTER TABLE daily_bank_statements ADD COLUMN file_size BIGINT NULL'
        );
      }
      if (!(await columnExists('daily_bank_statements', 'statement_total_debit_amount'))) {
        await pool.query(
          'ALTER TABLE daily_bank_statements ADD COLUMN statement_total_debit_amount DECIMAL(15, 2) NULL'
        );
      }
      if (!(await columnExists('daily_bank_statements', 'statement_total_credit_amount'))) {
        await pool.query(
          'ALTER TABLE daily_bank_statements ADD COLUMN statement_total_credit_amount DECIMAL(15, 2) NULL'
        );
      }
      if (!(await columnExists('daily_bank_statements', 'statement_ledger_balance'))) {
        await pool.query(
          'ALTER TABLE daily_bank_statements ADD COLUMN statement_ledger_balance DECIMAL(15, 2) NULL'
        );
      }
      if (!(await columnExists('daily_bank_statements', 'uploaded_by'))) {
        await pool.query(
          'ALTER TABLE daily_bank_statements ADD COLUMN uploaded_by INT NULL'
        );
      }
      if (!(await columnExists('daily_bank_statements', 'uploaded_at'))) {
        await pool.query(
          'ALTER TABLE daily_bank_statements ADD COLUMN uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
        );
      }
    }

    if (await indexExists('daily_bank_statements', 'uk_daily_bank_statement_singleton')) {
      await pool.query(
        'ALTER TABLE daily_bank_statements DROP INDEX uk_daily_bank_statement_singleton'
      );
    }
    if (!(await indexExists('daily_bank_statements', 'uk_daily_bank_statement_currency'))) {
      await pool.query(
        'ALTER TABLE daily_bank_statements ADD UNIQUE KEY uk_daily_bank_statement_currency (currency)'
      );
    }

    // Create monthly_bank_statements (one row per month + currency, with two PDFs)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS monthly_bank_statements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        month_period CHAR(7) NOT NULL,
        currency ENUM('AED', 'USD', 'GBP') NOT NULL DEFAULT 'AED',
        bank_statement_original_filename VARCHAR(512) NOT NULL,
        bank_statement_stored_filename VARCHAR(512) NOT NULL,
        bank_statement_file_path VARCHAR(1024) NOT NULL,
        bank_statement_mime_type VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
        bank_statement_file_size BIGINT NULL,
        monthly_invoice_original_filename VARCHAR(512) NOT NULL,
        monthly_invoice_stored_filename VARCHAR(512) NOT NULL,
        monthly_invoice_file_path VARCHAR(1024) NOT NULL,
        monthly_invoice_mime_type VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
        monthly_invoice_file_size BIGINT NULL,
        uploaded_by INT NULL,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_monthly_bank_statement_month_currency (month_period, currency),
        CONSTRAINT fk_monthly_bank_statements_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    if (await tableExists('monthly_bank_statements')) {
      if (!(await columnExists('monthly_bank_statements', 'month_period'))) {
        await pool.query(
          'ALTER TABLE monthly_bank_statements ADD COLUMN month_period CHAR(7) NOT NULL DEFAULT "1970-01"'
        );
      }
      if (!(await columnExists('monthly_bank_statements', 'currency'))) {
        await pool.query(
          `ALTER TABLE monthly_bank_statements
           ADD COLUMN currency ENUM('AED', 'USD', 'GBP') NOT NULL DEFAULT 'AED'`
        );
      }
      if (!(await columnExists('monthly_bank_statements', 'bank_statement_original_filename'))) {
        await pool.query(
          'ALTER TABLE monthly_bank_statements ADD COLUMN bank_statement_original_filename VARCHAR(512) NOT NULL DEFAULT "bank-statement.pdf"'
        );
      }
      if (!(await columnExists('monthly_bank_statements', 'bank_statement_stored_filename'))) {
        await pool.query(
          'ALTER TABLE monthly_bank_statements ADD COLUMN bank_statement_stored_filename VARCHAR(512) NOT NULL DEFAULT "bank-statement.pdf"'
        );
      }
      if (!(await columnExists('monthly_bank_statements', 'bank_statement_file_path'))) {
        await pool.query(
          'ALTER TABLE monthly_bank_statements ADD COLUMN bank_statement_file_path VARCHAR(1024) NOT NULL DEFAULT ""'
        );
      }
      if (!(await columnExists('monthly_bank_statements', 'bank_statement_mime_type'))) {
        await pool.query(
          'ALTER TABLE monthly_bank_statements ADD COLUMN bank_statement_mime_type VARCHAR(100) NOT NULL DEFAULT "application/pdf"'
        );
      }
      if (!(await columnExists('monthly_bank_statements', 'bank_statement_file_size'))) {
        await pool.query(
          'ALTER TABLE monthly_bank_statements ADD COLUMN bank_statement_file_size BIGINT NULL'
        );
      }
      if (!(await columnExists('monthly_bank_statements', 'monthly_invoice_original_filename'))) {
        await pool.query(
          'ALTER TABLE monthly_bank_statements ADD COLUMN monthly_invoice_original_filename VARCHAR(512) NOT NULL DEFAULT "monthly-invoice.pdf"'
        );
      }
      if (!(await columnExists('monthly_bank_statements', 'monthly_invoice_stored_filename'))) {
        await pool.query(
          'ALTER TABLE monthly_bank_statements ADD COLUMN monthly_invoice_stored_filename VARCHAR(512) NOT NULL DEFAULT "monthly-invoice.pdf"'
        );
      }
      if (!(await columnExists('monthly_bank_statements', 'monthly_invoice_file_path'))) {
        await pool.query(
          'ALTER TABLE monthly_bank_statements ADD COLUMN monthly_invoice_file_path VARCHAR(1024) NOT NULL DEFAULT ""'
        );
      }
      if (!(await columnExists('monthly_bank_statements', 'monthly_invoice_mime_type'))) {
        await pool.query(
          'ALTER TABLE monthly_bank_statements ADD COLUMN monthly_invoice_mime_type VARCHAR(100) NOT NULL DEFAULT "application/pdf"'
        );
      }
      if (!(await columnExists('monthly_bank_statements', 'monthly_invoice_file_size'))) {
        await pool.query(
          'ALTER TABLE monthly_bank_statements ADD COLUMN monthly_invoice_file_size BIGINT NULL'
        );
      }
      if (!(await columnExists('monthly_bank_statements', 'uploaded_by'))) {
        await pool.query(
          'ALTER TABLE monthly_bank_statements ADD COLUMN uploaded_by INT NULL'
        );
      }
      if (!(await columnExists('monthly_bank_statements', 'uploaded_at'))) {
        await pool.query(
          'ALTER TABLE monthly_bank_statements ADD COLUMN uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
        );
      }
    }

    if (!(await indexExists('monthly_bank_statements', 'uk_monthly_bank_statement_month_currency'))) {
      await pool.query(
        'ALTER TABLE monthly_bank_statements ADD UNIQUE KEY uk_monthly_bank_statement_month_currency (month_period, currency)'
      );
    }

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
    await ensureIndex('emirates_transactions', 'idx_emirates_transactions_date', '`date`');
    await ensureIndex('emirates_transactions', 'idx_emirates_transactions_account', 'account_number');
    await ensureIndex('emirates_transactions', 'idx_emirates_transactions_currency', 'currency');

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
