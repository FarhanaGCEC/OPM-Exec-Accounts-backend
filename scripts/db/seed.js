require('dotenv').config();

const bcrypt = require('bcryptjs');
const { pool, initDatabase } = require('../../src/config/database');

async function ensureAdminUser() {
  const username = process.env.SEED_ADMIN_USERNAME || 'admin';
  const password = process.env.SEED_ADMIN_PASSWORD || 'admin123';

  const existing = await pool.query('SELECT id FROM users WHERE username = ? LIMIT 1', [username]);
  if (existing.rows.length) return { created: false, username };

  const hashed = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashed]);
  return { created: true, username, password: process.env.SEED_ADMIN_PASSWORD ? '(from env)' : 'admin123' };
}

async function seedUniqueNames(table, names) {
  const existing = await pool.query(`SELECT name FROM ${table}`);
  const existingSet = new Set(existing.rows.map((r) => String(r.name).toLowerCase()));

  let inserted = 0;
  for (const name of names) {
    const key = String(name).trim().toLowerCase();
    if (!key || existingSet.has(key)) continue;
    await pool.query(`INSERT INTO ${table} (name) VALUES (?)`, [String(name).trim()]);
    existingSet.add(key);
    inserted++;
  }
  return inserted;
}

async function main() {
  // Ensure schema/tables exist first
  await initDatabase();

  // Seed categories (edit these lists to match your business)
  const payables = [
    'Office Rent',
    'Utilities',
    'Salaries',
    'Supplier Payment',
    'Transport',
    'Misc Expense',
  ];

  const receivables = [
    'Customer Payment',
    'Sales',
    'Refund',
    'Other Income',
  ];

  const insertedPayables = await seedUniqueNames('payables_categories', payables);
  const insertedReceivables = await seedUniqueNames('receivables_categories', receivables);

  const admin = await ensureAdminUser();

  console.log('✅ db:seed done', {
    payablesInserted: insertedPayables,
    receivablesInserted: insertedReceivables,
    adminUser: admin.created ? `created (${admin.username})` : `exists (${admin.username})`,
  });
}

main().catch((err) => {
  console.error('❌ db:seed failed:', err && err.message ? err.message : err);
  process.exit(1);
});

