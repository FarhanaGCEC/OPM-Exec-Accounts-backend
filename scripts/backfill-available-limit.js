require('dotenv').config();

const { initDatabase } = require('../src/config/database');
const {
  backfillStatementAvailableLimits,
} = require('../src/services/backfillStatementAvailableLimits');
const { terminateOcrWorker } = require('../src/utils/ocrStatementPage');

async function main() {
  const force = process.argv.includes('--force');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

  await initDatabase();
  console.log('Backfilling available_limit from existing statement PDFs...');
  const summary = await backfillStatementAvailableLimits({ force, limit });

  console.log('\nDone:', {
    total: summary.total,
    updated: summary.updated,
    skippedNoFile: summary.skippedNoFile,
    skippedNotPdf: summary.skippedNotPdf,
    skippedNoValue: summary.skippedNoValue,
    errors: summary.errors,
  });

  for (const r of summary.results) {
    if (r.status === 'updated') {
      console.log(`  ✓ ${r.id} (${r.statement_month}) → ${r.available_limit}`);
    } else if (r.status === 'cleared') {
      console.log(`  ○ ${r.id} (${r.statement_month}) cleared (no reliable value)`);
    } else if (r.status === 'error') {
      console.log(`  ✗ ${r.id}: ${r.error}`);
    }
  }

  await terminateOcrWorker();
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err && err.message ? err.message : err);
  process.exit(1);
});
