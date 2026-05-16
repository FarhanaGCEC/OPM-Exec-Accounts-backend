const { pool } = require('../config/database');
const fs = require('fs');
const path = require('path');

class DailyBankStatement {
  static async getCurrent(currency = 'AED') {
    const result = await pool.query(
      `SELECT
         id,
         currency,
         original_filename,
         stored_filename,
         file_path,
         mime_type,
         file_size,
         statement_total_debit_amount,
         statement_total_credit_amount,
         statement_ledger_balance,
         uploaded_by,
         uploaded_at,
         updated_at
       FROM daily_bank_statements
       WHERE currency = ?
       LIMIT 1`
      ,
      [currency]
    );
    return result.rows[0] || null;
  }

  static async upsert({
    currency = 'AED',
    originalFilename,
    storedFilename,
    filePath,
    mimeType,
    fileSize,
    uploadedBy,
    statementTotalDebitAmount = null,
    statementTotalCreditAmount = null,
    statementLedgerBalance = null
  }) {
    await pool.query(
      `INSERT INTO daily_bank_statements
       (
         currency,
         original_filename,
         stored_filename,
         file_path,
         mime_type,
         file_size,
         uploaded_by,
         statement_total_debit_amount,
         statement_total_credit_amount,
         statement_ledger_balance
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         original_filename = VALUES(original_filename),
         stored_filename = VALUES(stored_filename),
         file_path = VALUES(file_path),
         mime_type = VALUES(mime_type),
         file_size = VALUES(file_size),
         uploaded_by = VALUES(uploaded_by),
         statement_total_debit_amount = VALUES(statement_total_debit_amount),
         statement_total_credit_amount = VALUES(statement_total_credit_amount),
         statement_ledger_balance = VALUES(statement_ledger_balance),
         uploaded_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`,
      [
        currency,
        originalFilename,
        storedFilename,
        filePath,
        mimeType || 'application/pdf',
        fileSize || null,
        uploadedBy || null,
        statementTotalDebitAmount,
        statementTotalCreditAmount,
        statementLedgerBalance
      ]
    );

    return this.getCurrent(currency);
  }

  static async clear(currency = 'AED') {
    await pool.query('DELETE FROM daily_bank_statements WHERE currency = ?', [currency]);
  }

  static async resolveReadableFilePath(record) {
    if (!record) return null;

    const basenameFromPath = record.file_path ? path.basename(record.file_path) : null;
    const filename = record.stored_filename || basenameFromPath;
    const cwd = process.cwd();
    const parent = path.dirname(cwd);
    const candidateDirs = [
      cwd,
      parent,
      path.join(cwd, 'build'),
      path.join(parent, 'build'),
      path.join(cwd, 'uploads'),
      path.join(parent, 'uploads')
    ];

    const dirCandidates = [];
    for (const baseDir of candidateDirs) {
      dirCandidates.push(path.join(baseDir, 'daily-bank-statements'));
      dirCandidates.push(path.join(baseDir, 'uploads', 'daily-bank-statements'));
      dirCandidates.push(path.join(baseDir, 'build', 'daily-bank-statements'));
      dirCandidates.push(path.join(baseDir, 'build', 'uploads', 'daily-bank-statements'));
    }

    const currency = String(record.currency || 'AED').toUpperCase().trim();
    const currencySubdirs = ['AED', 'USD', 'GBP', currency].filter(Boolean);
    const uniqueDirs = Array.from(new Set(dirCandidates));
    const filenameCandidates = [];
    if (filename) {
      for (const dir of uniqueDirs) {
        filenameCandidates.push(path.join(dir, filename));
        for (const code of currencySubdirs) {
          filenameCandidates.push(path.join(dir, code, filename));
        }
      }
    }
    const candidates = [
      record.file_path,
      ...filenameCandidates
    ].filter(Boolean);

    for (const candidate of candidates) {
      try {
        await fs.promises.access(candidate, fs.constants.F_OK);
        return candidate;
      } catch (_error) {
        // Try next candidate path.
      }
    }

    return null;
  }
}

module.exports = DailyBankStatement;
