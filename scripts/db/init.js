require('dotenv').config();

const { initDatabase } = require('../../src/config/database');

async function main() {
  await initDatabase();
  console.log('✅ db:init done');
}

main().catch((err) => {
  console.error('❌ db:init failed:', err && err.message ? err.message : err);
  process.exit(1);
});

