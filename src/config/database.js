const { Pool } = require('pg');

// Database configuration
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'gcec_account_system',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test database connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Test database connection
const testConnection = async () => {
  try {
    const result = await pool.query('SELECT NOW()');
    console.log('Database connection test successful');
    return true;
  } catch (error) {
    console.error('Database connection failed:', error.message);
    if (error.code === '28P01') {
      console.error('\n❌ Password authentication failed!');
      console.error('Please check your database credentials in the .env file or environment variables.');
      console.error('\nRequired environment variables:');
      console.error('  DB_HOST=localhost');
      console.error('  DB_PORT=5432');
      console.error('  DB_NAME=gcec_account_system');
      console.error('  DB_USER=postgres');
      console.error('  DB_PASSWORD=your_actual_password');
      console.error('\nTo find your PostgreSQL password, try:');
      console.error('  - Check if you set a password during PostgreSQL installation');
      console.error('  - Try connecting with: psql -U postgres');
      console.error('  - Or reset the password if needed\n');
    }
    throw error;
  }
};

// Fix existing card data: Update card numbers to full and expiry to MMM-YY format
const fixExistingCardData = async () => {
  try {
    // Full card data mapping by bank name and holder (most reliable)
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

    // Get all existing cards
    const existingCards = await pool.query(`
      SELECT id, card_holder, card_number, expiry_date, issuing_bank, billing_cycle_days, statement_day, display_order 
      FROM credit_cards_new
    `);

    let updatedCount = 0;

    for (const existingCard of existingCards.rows) {
      // Find matching default card by bank and holder
      const matchingCard = defaultCardsData.find(
        card => card.issuingBank === existingCard.issuing_bank && 
                card.cardHolder === existingCard.card_holder
      );

      if (matchingCard) {
        // Check if card_number needs update (if it's only 4 digits or doesn't match)
        const currentCardNum = existingCard.card_number.trim().replace(/\s/g, '');
        const expectedCardNum = matchingCard.cardNumber.trim().replace(/\s/g, '');
        const cardNumberNeedsUpdate = currentCardNum.length <= 4 || currentCardNum !== expectedCardNum;
        
        // Check if expiry_date needs update (if it's DATE format or doesn't match MMM-YY)
        const expiryNeedsUpdate = !existingCard.expiry_date.match(/^[A-Za-z]{3}-\d{2}$/) || 
                                   existingCard.expiry_date !== matchingCard.expiry;

        // Check if billing_cycle_days needs update
        const billingCycleNeedsUpdate = matchingCard.billingCycleDays && 
          existingCard.billing_cycle_days !== matchingCard.billingCycleDays;
        
        // Check if statement_day needs update
        const statementDayNeedsUpdate = matchingCard.statementDay && 
          existingCard.statement_day !== matchingCard.statementDay;
        
        // Check if display_order needs update
        const displayOrderNeedsUpdate = matchingCard.displayOrder && 
          existingCard.display_order !== matchingCard.displayOrder;

        if (cardNumberNeedsUpdate || expiryNeedsUpdate || billingCycleNeedsUpdate || statementDayNeedsUpdate || displayOrderNeedsUpdate) {
          const updates = [];
          const values = [];
          let paramCount = 0;

          if (cardNumberNeedsUpdate) {
            paramCount++;
            updates.push(`card_number = $${paramCount}`);
            values.push(matchingCard.cardNumber.trim());
          }
          if (expiryNeedsUpdate) {
            paramCount++;
            updates.push(`expiry_date = $${paramCount}`);
            values.push(matchingCard.expiry.trim());
          }
          if (billingCycleNeedsUpdate) {
            paramCount++;
            updates.push(`billing_cycle_days = $${paramCount}`);
            values.push(matchingCard.billingCycleDays);
          }
          if (statementDayNeedsUpdate) {
            paramCount++;
            updates.push(`statement_day = $${paramCount}`);
            values.push(matchingCard.statementDay);
          }
          if (displayOrderNeedsUpdate) {
            paramCount++;
            updates.push(`display_order = $${paramCount}`);
            values.push(matchingCard.displayOrder);
          }

          paramCount++;
          updates.push(`updated_at = CURRENT_TIMESTAMP`);
          values.push(existingCard.id);

          await pool.query(
            `UPDATE credit_cards_new 
             SET ${updates.join(', ')}
             WHERE id = $${paramCount}`,
            values
          );
          updatedCount++;
          console.log(`✅ Fixed card: ${matchingCard.issuingBank} - ${matchingCard.cardHolder} (${matchingCard.cardNumber}, ${matchingCard.expiry}, ${matchingCard.billingCycleDays} days)`);
        }
      }
    }

    if (updatedCount > 0) {
      console.log(`✅ Fixed ${updatedCount} existing credit cards with full numbers and correct expiry format`);
    }
  } catch (error) {
    console.error('Error fixing existing card data:', error.message);
    // Don't throw - allow server to continue
  }
};

// Seed default credit cards for new system (credit_cards_new table)
const seedDefaultCreditCardsNew = async () => {
  try {
    // Check if any cards already exist
    const existingCards = await pool.query(
      'SELECT COUNT(*) FROM credit_cards_new'
    );

    // Only seed if no cards exist
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
        // Keep expiry in "MMM-YY" format (e.g., "Feb-28")
        const expiryDate = card.expiry.trim();
        // Store full card number
        const fullCardNumber = card.cardNumber.trim();

        await pool.query(
          `INSERT INTO credit_cards_new 
           (issuing_bank, card_holder, card_number, expiry_date, billing_cycle_days, statement_day, display_order, is_active) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            card.issuingBank,
            card.cardHolder,
            fullCardNumber,
            expiryDate,
            card.billingCycleDays !== undefined ? card.billingCycleDays : 25,
            card.statementDay !== undefined ? card.statementDay : 1,
            card.displayOrder !== undefined ? card.displayOrder : 999,
            true // All default cards are active
          ]
        );
      }

      console.log(`✅ Seeded ${defaultCards.length} default credit cards (new system)`);
    }
  } catch (error) {
    console.error('Error seeding default credit cards (new system):', error.message);
    // Don't throw - allow server to start even if seeding fails
  }
};

// Seed default credit cards
const seedDefaultCreditCards = async () => {
  try {
    // Check if any system cards already exist
    const existingSystemCards = await pool.query(
      'SELECT COUNT(*) FROM credit_cards WHERE is_system = true'
    );

    // Only seed if no system cards exist
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
          `INSERT INTO credit_cards 
           (issuing_bank, card_holder, card_number, expiry, cvv, amount_limit, is_system, is_default) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            card.issuingBank,
            card.cardHolder,
            card.cardNumber,
            card.expiry,
            card.cvv,
            card.amountLimit,
            card.isSystem,
            card.isDefault
          ]
        );
      }

      console.log(`✅ Seeded ${defaultCards.length} default credit cards`);
    }
  } catch (error) {
    console.error('Error seeding default credit cards:', error.message);
    // Don't throw - allow server to start even if seeding fails
  }
};

// Initialize database schema
const initDatabase = async () => {
  try {
    // Test connection first
    await testConnection();
    
    // Create users table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create payables_categories table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payables_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create receivables_categories table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS receivables_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create transactions table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL,
        type VARCHAR(10) NOT NULL CHECK (type IN ('Debit', 'Credit')),
        category_id INTEGER,
        category_type VARCHAR(20) CHECK (category_type IN ('payable', 'receivable')),
        payment_type VARCHAR(50) NOT NULL,
        cheque_number VARCHAR(50),
        amount DECIMAL(15, 2) NOT NULL,
        balance DECIMAL(15, 2) NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add category_type column if table exists but column doesn't
    await pool.query(`
      DO $$ 
      BEGIN
        -- Drop old foreign key constraint if exists
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints 
          WHERE constraint_name = 'transactions_category_id_fkey'
        ) THEN
          ALTER TABLE transactions DROP CONSTRAINT transactions_category_id_fkey;
        END IF;
        
        -- Add category_type column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'transactions' AND column_name = 'category_type'
        ) THEN
          ALTER TABLE transactions ADD COLUMN category_type VARCHAR(20) CHECK (category_type IN ('payable', 'receivable'));
        END IF;
      END $$;
    `);

    // Add created_by column if table exists but column doesn't
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'transactions' AND column_name = 'created_by'
        ) THEN
          ALTER TABLE transactions ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // Add remarks column if table exists but column doesn't
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'transactions' AND column_name = 'remarks'
        ) THEN
          ALTER TABLE transactions ADD COLUMN remarks TEXT;
        END IF;
      END $$;
    `);

    // Create index for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date DESC)
    `);

    // Create post_dated_cheques table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS post_dated_cheques (
        id SERIAL PRIMARY KEY,
        cheque_date DATE NOT NULL,
        cheque_number VARCHAR(100) NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        amount DECIMAL(15, 2) NOT NULL,
        cheque_type VARCHAR(50) NOT NULL,
        pdc_type VARCHAR(50) NOT NULL CHECK (pdc_type IN ('GCEC PDC', 'Customer PDC', 'Custom PDC')),
        description TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add cheque_type column if table exists but column doesn't
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'post_dated_cheques' AND column_name = 'cheque_type'
        ) THEN
          ALTER TABLE post_dated_cheques ADD COLUMN cheque_type VARCHAR(50) NOT NULL DEFAULT 'Payment Cheque';
        END IF;
      END $$;
    `);

    // Create index for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_pdc_cheque_date ON post_dated_cheques(cheque_date DESC)
    `);

    // Create credit_card_payments table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_card_payments (
        id SERIAL PRIMARY KEY,
        payment_date DATE NOT NULL,
        credit_card_id UUID REFERENCES credit_cards_new(id) ON DELETE CASCADE,
        customer_name VARCHAR(255),
        payment_method VARCHAR(50) NOT NULL DEFAULT 'Credit Card',
        amount DECIMAL(15, 2) NOT NULL,
        remarks TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Add credit_card_id column if it doesn't exist (migration)
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'credit_card_payments' AND column_name = 'credit_card_id'
        ) THEN
          ALTER TABLE credit_card_payments ADD COLUMN credit_card_id UUID REFERENCES credit_cards_new(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `);
    
    // Add remarks column if it doesn't exist (migration)
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'credit_card_payments' AND column_name = 'remarks'
        ) THEN
          ALTER TABLE credit_card_payments ADD COLUMN remarks TEXT;
        END IF;
      END $$;
    `);

    // Create index for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_cc_payment_date ON credit_card_payments(payment_date DESC)
    `);

    // Create credit_cards table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_cards (
        id SERIAL PRIMARY KEY,
        issuing_bank VARCHAR(255) NOT NULL,
        card_holder VARCHAR(255) NOT NULL,
        card_number VARCHAR(50) NOT NULL,
        expiry VARCHAR(10) NOT NULL,
        cvv VARCHAR(10),
        amount_limit DECIMAL(15, 2),
        is_system BOOLEAN DEFAULT FALSE,
        is_default BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_credit_cards_is_system ON credit_cards(is_system DESC)
    `);

    // Create credit_card_statements table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_card_statements (
        id SERIAL PRIMARY KEY,
        card_id INTEGER NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
        statement_month INTEGER NOT NULL CHECK (statement_month >= 1 AND statement_month <= 12),
        statement_year INTEGER NOT NULL,
        statement_date DATE NOT NULL,
        due_date DATE NOT NULL,
        due_month VARCHAR(50),
        total_payment_due DECIMAL(15, 2) NOT NULL DEFAULT 0,
        paid DECIMAL(15, 2) NOT NULL DEFAULT 0,
        epp DECIMAL(15, 2) NOT NULL DEFAULT 0,
        amount_pending DECIMAL(15, 2) NOT NULL DEFAULT 0,
        status VARCHAR(10) NOT NULL CHECK (status IN ('PAID', 'DUE')) DEFAULT 'DUE',
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(card_id, statement_month, statement_year)
      )
    `);

    // Create indexes for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_cc_statements_card_month_year ON credit_card_statements(card_id, statement_month, statement_year)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_cc_statements_month_year ON credit_card_statements(statement_month, statement_year)
    `);

    // Seed default credit cards
    await seedDefaultCreditCards();

    // ============================================
    // NEW CREDIT CARD MANAGEMENT SYSTEM (UUID-based)
    // ============================================
    
    // Enable UUID extension
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp"
    `);

    // Create credit_cards table (new system)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_cards_new (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        issuing_bank VARCHAR(255) NOT NULL,
        card_holder VARCHAR(255) NOT NULL,
        card_number VARCHAR(50) NOT NULL,
        expiry_date VARCHAR(10) NOT NULL,
        credit_limit DECIMAL(15, 2),
        billing_cycle_days INTEGER NOT NULL DEFAULT 25,
        statement_day INTEGER NOT NULL DEFAULT 1 CHECK (statement_day >= 1 AND statement_day <= 31),
        display_order INTEGER NOT NULL DEFAULT 999,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add billing_cycle_days column if table exists but column doesn't
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'credit_cards_new' AND column_name = 'billing_cycle_days'
        ) THEN
          ALTER TABLE credit_cards_new ADD COLUMN billing_cycle_days INTEGER NOT NULL DEFAULT 25;
        END IF;
      END $$;
    `);

    // Add statement_day column if table exists but column doesn't
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'credit_cards_new' AND column_name = 'statement_day'
        ) THEN
          ALTER TABLE credit_cards_new ADD COLUMN statement_day INTEGER NOT NULL DEFAULT 1 CHECK (statement_day >= 1 AND statement_day <= 31);
        END IF;
      END $$;
    `);

    // Add display_order column if table exists but column doesn't
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'credit_cards_new' AND column_name = 'display_order'
        ) THEN
          ALTER TABLE credit_cards_new ADD COLUMN display_order INTEGER NOT NULL DEFAULT 999;
        END IF;
      END $$;
    `);

    // Migrate existing table: Handle column name changes
    await pool.query(`
      DO $$ 
      BEGIN
        -- Check if table exists
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'credit_cards_new') THEN
          -- Check if card_number_last4 column exists and rename it to card_number
          IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'credit_cards_new' AND column_name = 'card_number_last4'
          ) THEN
            -- Check if card_number column doesn't exist yet
            IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns 
              WHERE table_name = 'credit_cards_new' AND column_name = 'card_number'
            ) THEN
              ALTER TABLE credit_cards_new RENAME COLUMN card_number_last4 TO card_number;
              ALTER TABLE credit_cards_new ALTER COLUMN card_number TYPE VARCHAR(50);
            ELSE
              -- If both exist, drop the old one (data migration would be needed, but for now just drop)
              ALTER TABLE credit_cards_new DROP COLUMN IF EXISTS card_number_last4;
            END IF;
          END IF;
          
          -- Ensure expiry_date is VARCHAR if it's DATE type
          IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'credit_cards_new' 
            AND column_name = 'expiry_date' 
            AND data_type = 'date'
          ) THEN
            ALTER TABLE credit_cards_new ALTER COLUMN expiry_date TYPE VARCHAR(10);
          END IF;
        END IF;
      END $$;
    `);

    // Create index for active cards
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_credit_cards_new_active ON credit_cards_new(is_active) WHERE is_active = TRUE
    `);

    // Create card_statements table (new system)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS card_statements (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        credit_card_id UUID NOT NULL REFERENCES credit_cards_new(id) ON DELETE CASCADE,
        statement_month VARCHAR(7) NOT NULL CHECK (statement_month ~ '^[0-9]{4}-[0-9]{2}$'),
        statement_date DATE NOT NULL,
        due_date DATE NOT NULL,
        days INTEGER NOT NULL,
        due_month VARCHAR(50),
        total_due DECIMAL(15, 2) NOT NULL DEFAULT 0,
        paid_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
        pending_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
        epp_balance DECIMAL(15, 2) NOT NULL DEFAULT 0,
        balance_transfer DECIMAL(15, 2) NOT NULL DEFAULT 0,
        payment_status VARCHAR(10) NOT NULL CHECK (payment_status IN ('PAID', 'PARTIAL', 'OVERDUE')) DEFAULT 'PARTIAL',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(credit_card_id, statement_month)
      )
    `);

    // Add days column if table exists but column doesn't
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'card_statements' AND column_name = 'days'
        ) THEN
          ALTER TABLE card_statements ADD COLUMN days INTEGER NOT NULL DEFAULT 25;
        END IF;
      END $$;
    `);

    // Add due_month column if table exists but column doesn't
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'card_statements' AND column_name = 'due_month'
        ) THEN
          ALTER TABLE card_statements ADD COLUMN due_month VARCHAR(50);
        END IF;
      END $$;
    `);

    // Create indexes for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_card_statements_month ON card_statements(statement_month DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_card_statements_card_month ON card_statements(credit_card_id, statement_month DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_card_statements_status ON card_statements(payment_status)
    `);

    // Seed default credit cards for new system
    await seedDefaultCreditCardsNew();
    
    // Fix existing cards: Update card numbers and expiry dates to correct format
    await fixExistingCardData();

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

