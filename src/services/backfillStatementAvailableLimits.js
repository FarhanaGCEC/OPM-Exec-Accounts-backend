const { pool } = require('../config/database');
const Statement = require('../models/Statement');
const { fetchStatementAttachmentBuffer } = require('../utils/fetchStatementAttachmentBuffer');
const { parseAvailableLimitFromPdfBuffer } = require('../utils/parseCardStatementAvailableLimit');

/**
 * One-time / on-demand backfill: for statements that already have a PDF but
 * available_limit is NULL, download the file, extract, and save.
 *
 * @param {{ force?: boolean, limit?: number }} [options]
 *   force=true re-parses even when available_limit is already set
 */
async function backfillStatementAvailableLimits(options = {}) {
  const force = Boolean(options.force);
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.floor(Number(options.limit))
    : null;

  let sql = `
    SELECT id, attachment_name, attachment_storage_key, attachment_url,
           attachment_cloudinary_public_id, available_limit, statement_month
    FROM card_statements
    WHERE (
      attachment_url IS NOT NULL
      OR attachment_cloudinary_public_id IS NOT NULL
      OR attachment_storage_key IS NOT NULL
    )
  `;
  if (!force) {
    sql += ' AND available_limit IS NULL';
  }
  sql += ' ORDER BY updated_at DESC';
  if (limit) {
    sql += ` LIMIT ${limit}`;
  }

  const { rows } = await pool.query(sql);

  const summary = {
    total: rows.length,
    updated: 0,
    skippedNoFile: 0,
    skippedNotPdf: 0,
    skippedNoValue: 0,
    errors: 0,
    results: [],
  };

  for (const row of rows) {
    const entry = {
      id: row.id,
      statement_month: row.statement_month,
      status: null,
      available_limit: null,
      error: null,
    };

    try {
      const fetched = await fetchStatementAttachmentBuffer(row);
      if (!fetched || !fetched.buffer) {
        entry.status = 'skipped_no_file';
        summary.skippedNoFile += 1;
        summary.results.push(entry);
        continue;
      }

      if (fetched.kind !== 'pdf') {
        entry.status = 'skipped_not_pdf';
        summary.skippedNotPdf += 1;
        summary.results.push(entry);
        continue;
      }

      const availableLimit = await parseAvailableLimitFromPdfBuffer(fetched.buffer);
      if (availableLimit == null || Number.isNaN(Number(availableLimit))) {
        // On force re-run, clear previously stored bad / stale values
        if (force && row.available_limit != null) {
          await Statement.update(row.id, { availableLimit: null });
          entry.status = 'cleared';
          summary.updated += 1;
        } else {
          entry.status = 'skipped_no_value';
          summary.skippedNoValue += 1;
        }
        summary.results.push(entry);
        continue;
      }

      await Statement.update(row.id, { availableLimit: Number(availableLimit) });
      entry.status = 'updated';
      entry.available_limit = Number(availableLimit);
      summary.updated += 1;
      summary.results.push(entry);
    } catch (err) {
      entry.status = 'error';
      entry.error = err.message || String(err);
      summary.errors += 1;
      summary.results.push(entry);
      console.error(`[STATEMENT] backfill available_limit failed for ${row.id}:`, err.message);
    }
  }

  return summary;
}

module.exports = {
  backfillStatementAvailableLimits,
};
