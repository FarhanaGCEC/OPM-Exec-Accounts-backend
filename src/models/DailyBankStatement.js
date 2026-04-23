const { pool } = require('../config/database');

class DailyBankStatement {
  static async getCurrent() {
    const result = await pool.query(
      `SELECT
         id,
         singleton_key,
         original_filename,
         stored_filename,
         file_path,
         mime_type,
         file_size,
         uploaded_by,
         uploaded_at,
         updated_at
       FROM daily_bank_statements
       WHERE singleton_key = 1
       LIMIT 1`
    );
    return result.rows[0] || null;
  }

  static async upsert({ originalFilename, storedFilename, filePath, mimeType, fileSize, uploadedBy }) {
    await pool.query(
      `INSERT INTO daily_bank_statements
       (singleton_key, original_filename, stored_filename, file_path, mime_type, file_size, uploaded_by)
       VALUES (1, ?, ?, ?, ?, ?, ?)
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
        originalFilename,
        storedFilename,
        filePath,
        mimeType || 'application/pdf',
        fileSize || null,
        uploadedBy || null
      ]
    );

    return this.getCurrent();
  }

  static async clear() {
    await pool.query('DELETE FROM daily_bank_statements WHERE singleton_key = 1');
  }
}

module.exports = DailyBankStatement;
