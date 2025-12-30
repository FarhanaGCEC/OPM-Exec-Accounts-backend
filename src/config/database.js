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

