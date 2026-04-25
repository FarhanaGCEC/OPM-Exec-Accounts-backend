const { pool } = require('../config/database');

class MonthlyBankStatement {
  static async getOne({ monthPeriod, currency }) {
    const result = await pool.query(
      `SELECT
         id,
         month_period,
         currency,
         bank_statement_original_filename,
         bank_statement_stored_filename,
         bank_statement_file_path,
         bank_statement_mime_type,
         bank_statement_file_size,
         monthly_invoice_original_filename,
         monthly_invoice_stored_filename,
         monthly_invoice_file_path,
         monthly_invoice_mime_type,
         monthly_invoice_file_size,
         uploaded_by,
         uploaded_at,
         updated_at
       FROM monthly_bank_statements
       WHERE month_period = ? AND currency = ?
       LIMIT 1`,
      [monthPeriod, currency]
    );
    return result.rows[0] || null;
  }

  static async upsert({
    monthPeriod,
    currency,
    bankStatement,
    monthlyInvoice,
    uploadedBy
  }) {
    await pool.query(
      `INSERT INTO monthly_bank_statements
       (
         month_period,
         currency,
         bank_statement_original_filename,
         bank_statement_stored_filename,
         bank_statement_file_path,
         bank_statement_mime_type,
         bank_statement_file_size,
         monthly_invoice_original_filename,
         monthly_invoice_stored_filename,
         monthly_invoice_file_path,
         monthly_invoice_mime_type,
         monthly_invoice_file_size,
         uploaded_by
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         bank_statement_original_filename = VALUES(bank_statement_original_filename),
         bank_statement_stored_filename = VALUES(bank_statement_stored_filename),
         bank_statement_file_path = VALUES(bank_statement_file_path),
         bank_statement_mime_type = VALUES(bank_statement_mime_type),
         bank_statement_file_size = VALUES(bank_statement_file_size),
         monthly_invoice_original_filename = VALUES(monthly_invoice_original_filename),
         monthly_invoice_stored_filename = VALUES(monthly_invoice_stored_filename),
         monthly_invoice_file_path = VALUES(monthly_invoice_file_path),
         monthly_invoice_mime_type = VALUES(monthly_invoice_mime_type),
         monthly_invoice_file_size = VALUES(monthly_invoice_file_size),
         uploaded_by = VALUES(uploaded_by),
         uploaded_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`,
      [
        monthPeriod,
        currency,
        bankStatement.originalFilename,
        bankStatement.storedFilename,
        bankStatement.filePath,
        bankStatement.mimeType || 'application/pdf',
        bankStatement.fileSize || null,
        monthlyInvoice.originalFilename,
        monthlyInvoice.storedFilename,
        monthlyInvoice.filePath,
        monthlyInvoice.mimeType || 'application/pdf',
        monthlyInvoice.fileSize || null,
        uploadedBy || null
      ]
    );

    return this.getOne({ monthPeriod, currency });
  }

  static async clear({ monthPeriod, currency }) {
    await pool.query(
      'DELETE FROM monthly_bank_statements WHERE month_period = ? AND currency = ?',
      [monthPeriod, currency]
    );
  }
}

module.exports = MonthlyBankStatement;
