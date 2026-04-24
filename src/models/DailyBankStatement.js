const { pool } = require('../config/database');

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

  static async upsert({ currency = 'AED', originalFilename, storedFilename, filePath, mimeType, fileSize, uploadedBy }) {
    await pool.query(
      `INSERT INTO daily_bank_statements
       (currency, original_filename, stored_filename, file_path, mime_type, file_size, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         original_filename = VALUES(original_filename),
         stored_filename = VALUES(stored_filename),
         file_path = VALUES(file_path),
         mime_type = VALUES(mime_type),
         file_size = VALUES(file_size),
         uploaded_by = VALUES(uploaded_by),
         uploaded_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`,
      [
        currency,
        originalFilename,
        storedFilename,
        filePath,
        mimeType || 'application/pdf',
        fileSize || null,
        uploadedBy || null
      ]
    );

    return this.getCurrent(currency);
  }

  static async clear(currency = 'AED') {
    await pool.query('DELETE FROM daily_bank_statements WHERE currency = ?', [currency]);
  }
}

module.exports = DailyBankStatement;
