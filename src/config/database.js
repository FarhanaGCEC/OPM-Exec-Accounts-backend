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
        customer_name VARCHAR(255) NOT NULL,
        payment_method VARCHAR(50) NOT NULL DEFAULT 'Credit Card',
        amount DECIMAL(15, 2) NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_cc_payment_date ON credit_card_payments(payment_date DESC)
    `);

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

