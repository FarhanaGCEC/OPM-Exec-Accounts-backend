const { pool } = require('../config/database');

const EMPTY_BANK_STATEMENT = {
  originalFilename: 'bank-statement.pdf',
  storedFilename: 'bank-statement.pdf',
  filePath: '',
  mimeType: 'application/pdf',
  fileSize: null
};

const EMPTY_MONTHLY_INVOICE = {
  originalFilename: 'monthly-invoice.pdf',
  storedFilename: 'monthly-invoice.pdf',
  filePath: '',
  mimeType: 'application/pdf',
  fileSize: null
};

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

  static async clearFileType({ monthPeriod, currency, fileType, uploadedBy }) {
    const isBankStatement = fileType === 'bank_statement';
    const cleared = isBankStatement ? EMPTY_BANK_STATEMENT : EMPTY_MONTHLY_INVOICE;
    const prefix = isBankStatement ? 'bank_statement' : 'monthly_invoice';
    await pool.query(
      `UPDATE monthly_bank_statements
       SET ${prefix}_original_filename = ?,
           ${prefix}_stored_filename = ?,
           ${prefix}_file_path = ?,
           ${prefix}_mime_type = ?,
           ${prefix}_file_size = ?,
           uploaded_by = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE month_period = ? AND currency = ?`,
      [
        cleared.originalFilename,
        cleared.storedFilename,
        cleared.filePath,
        cleared.mimeType,
        cleared.fileSize,
        uploadedBy || null,
        monthPeriod,
        currency
      ]
    );
    return this.getOne({ monthPeriod, currency });
  }

  static async upsertSingleType({
    monthPeriod,
    currency,
    fileType,
    fileData,
    uploadedBy
  }) {
    const isBankStatement = fileType === 'bank_statement';
    const current = await this.getOne({ monthPeriod, currency });
    const bankStatement = isBankStatement
      ? fileData
      : {
          originalFilename:
            current?.bank_statement_original_filename || EMPTY_BANK_STATEMENT.originalFilename,
          storedFilename:
            current?.bank_statement_stored_filename || EMPTY_BANK_STATEMENT.storedFilename,
          filePath: current?.bank_statement_file_path || EMPTY_BANK_STATEMENT.filePath,
          mimeType: current?.bank_statement_mime_type || EMPTY_BANK_STATEMENT.mimeType,
          fileSize: current?.bank_statement_file_size || EMPTY_BANK_STATEMENT.fileSize
        };
    const monthlyInvoice = isBankStatement
      ? {
          originalFilename:
            current?.monthly_invoice_original_filename || EMPTY_MONTHLY_INVOICE.originalFilename,
          storedFilename:
            current?.monthly_invoice_stored_filename || EMPTY_MONTHLY_INVOICE.storedFilename,
          filePath: current?.monthly_invoice_file_path || EMPTY_MONTHLY_INVOICE.filePath,
          mimeType: current?.monthly_invoice_mime_type || EMPTY_MONTHLY_INVOICE.mimeType,
          fileSize: current?.monthly_invoice_file_size || EMPTY_MONTHLY_INVOICE.fileSize
        }
      : fileData;

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
        bankStatement.mimeType || EMPTY_BANK_STATEMENT.mimeType,
        bankStatement.fileSize || null,
        monthlyInvoice.originalFilename,
        monthlyInvoice.storedFilename,
        monthlyInvoice.filePath,
        monthlyInvoice.mimeType || EMPTY_MONTHLY_INVOICE.mimeType,
        monthlyInvoice.fileSize || null,
        uploadedBy || null
      ]
    );

    return this.getOne({ monthPeriod, currency });
  }
}

module.exports = MonthlyBankStatement;
