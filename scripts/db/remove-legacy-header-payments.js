require('dotenv').config();

const { pool } = require('../../src/config/database');
const CardStatementPayment = require('../../src/models/CardStatementPayment');
const CardStatementEpp = require('../../src/models/CardStatementEpp');
const Statement = require('../../src/models/Statement');
const {
  sanitizeBreakdownEntries,
  sumBreakdownAmounts,
  normalizePaidAtYmd,
} = require('../../src/utils/statementPaymentEntries');

function rowsEqual(before, after) {
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    const b = after[i];
    if (round(a.amount) !== round(b.amount)) return false;
    if (normalizePaidAtYmd(a.paid_at) !== normalizePaidAtYmd(b.paid_at)) return false;
    if (String(a.note || '') !== String(b.note || '')) return false;
  }
  return true;
}

function round(n) {
  return Math.round(Number(n) * 100) / 100;
}

function toReplaceRows(rows) {
  return (rows || []).map((row, i) => ({
    amount: round(row.amount),
    paid_at: normalizePaidAtYmd(row.paid_at),
    note: row.note != null && String(row.note).trim() !== '' ? String(row.note).trim() : null,
    sort_order: row.sort_order != null ? row.sort_order : i,
  }));
}

async function cleanupBucket({ label, listStatements, listRows, replaceRows }) {
  const statements = await listStatements();
  let changedStatements = 0;
  let removedRows = 0;

  for (const stmt of statements) {
    const before = await listRows(stmt.id);
    if (!before.length) continue;

    const sanitized = sanitizeBreakdownEntries(before, stmt.statement_month);
    if (rowsEqual(before, sanitized)) continue;

    removedRows += before.length - sanitized.length;
    const replace = toReplaceRows(sanitized);
    await replaceRows(stmt.id, replace);

    const paidOrEppField = label === 'paid' ? 'paidAmount' : 'eppBalance';
    const total = sumBreakdownAmounts(replace);
    await Statement.update(stmt.id, { [paidOrEppField]: total });

    changedStatements += 1;
    console.log(
      `  ✓ ${stmt.issuing_bank || 'Card'} (${stmt.card_holder || '-'}) ${stmt.statement_month}: ${before.length} → ${sanitized.length} ${label} rows, total ${total}`
    );
  }

  return { changedStatements, removedRows };
}

async function main() {
  console.log('Cleaning duplicate paid / EPP breakdown rows...\n');

  const legacy = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM card_statement_payments WHERE note = 'legacy:header') AS paid_legacy,
       (SELECT COUNT(*) FROM card_statement_epp_payments WHERE note = 'legacy:header') AS epp_legacy`
  );
  console.log('Legacy header rows:', legacy.rows[0]);

  await pool.query(`DELETE FROM card_statement_payments WHERE note = 'legacy:header'`);
  await pool.query(`DELETE FROM card_statement_epp_payments WHERE note = 'legacy:header'`);

  const listStatements = async () => {
    const result = await pool.query(
      `SELECT s.id, s.statement_month, s.credit_card_id, c.issuing_bank, c.card_holder
       FROM card_statements s
       JOIN credit_cards_new c ON c.id = s.credit_card_id
       ORDER BY s.statement_month DESC, c.display_order`
    );
    return result.rows;
  };

  const paid = await cleanupBucket({
    label: 'paid',
    listStatements,
    listRows: CardStatementPayment.listByStatementId.bind(CardStatementPayment),
    replaceRows: CardStatementPayment.replaceForStatement.bind(CardStatementPayment),
  });

  const epp = await cleanupBucket({
    label: 'epp',
    listStatements,
    listRows: CardStatementEpp.listByStatementId.bind(CardStatementEpp),
    replaceRows: CardStatementEpp.replaceForStatement.bind(CardStatementEpp),
  });

  console.log('\nSummary:');
  console.log(`  Paid: ${paid.removedRows} duplicate row(s) removed across ${paid.changedStatements} statement(s)`);
  console.log(`  EPP:  ${epp.removedRows} duplicate row(s) removed across ${epp.changedStatements} statement(s)`);
  console.log('✅ Breakdown duplicate cleanup done');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Cleanup failed:', err && err.message ? err.message : err);
  process.exit(1);
});
