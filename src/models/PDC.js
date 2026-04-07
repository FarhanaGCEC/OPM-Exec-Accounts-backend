const { pool } = require('../config/database');
const { parseDailyLedgerApproved } = require('../utils/pdcLedgerApproval');

class PDC {
  // Helper method to format dates to ISO strings
  static formatDates(pdc) {
    if (!pdc) return pdc;
    const formatted = { ...pdc };
    if (pdc.cheque_date) {
      if (pdc.cheque_date instanceof Date) {
        // Format date in local timezone to avoid UTC conversion issues
        const year = pdc.cheque_date.getFullYear();
        const month = String(pdc.cheque_date.getMonth() + 1).padStart(2, '0');
        const day = String(pdc.cheque_date.getDate()).padStart(2, '0');
        formatted.cheque_date = `${year}-${month}-${day}`;
      } else {
        // Already a string, use as is
        formatted.cheque_date = pdc.cheque_date;
      }
    }
    if (pdc.created_at) {
      formatted.created_at = pdc.created_at instanceof Date 
       ? pdc.created_at.toISOString() 
        : pdc.created_at;
    }
    if (pdc.updated_at) {
      formatted.updated_at = pdc.updated_at instanceof Date 
       ? pdc.updated_at.toISOString() 
        : pdc.updated_at;
    }
    if (Object.prototype.hasOwnProperty.call(pdc, 'daily_ledger_approved')) {
      formatted.daily_ledger_approved = parseDailyLedgerApproved(pdc.daily_ledger_approved);
    }
    return formatted;
  }

  // Get all post-dated cheques
  static async getAll() {
    try {
      const result = await pool.query(`
        SELECT 
          pdc.id,
          DATE_FORMAT(pdc.cheque_date, '%Y-%m-%d') as cheque_date,
          pdc.cheque_number,
          pdc.customer_name,
          pdc.amount,
          pdc.cheque_type,
          pdc.pdc_type,
          pdc.description,
          pdc.daily_ledger_approved,
          pdc.attachment_name,
          pdc.attachment_url,
          pdc.attachment_cloudinary_public_id,
          pdc.created_by,
          u.username as created_by_username,
          pdc.created_at,
          pdc.updated_at
        FROM post_dated_cheques pdc
        LEFT JOIN users u ON pdc.created_by = u.id
        ORDER BY pdc.cheque_date ASC, pdc.created_at ASC
      `);
      return result.rows.map(row => this.formatDates(row));
    } catch (error) {
      throw error;
    }
  }

  // Get a single PDC by ID
  static async getById(id) {
    try {
      const result = await pool.query(`
        SELECT 
          pdc.id,
          DATE_FORMAT(pdc.cheque_date, '%Y-%m-%d') as cheque_date,
          pdc.cheque_number,
          pdc.customer_name,
          pdc.amount,
          pdc.cheque_type,
          pdc.pdc_type,
          pdc.description,
          pdc.daily_ledger_approved,
          pdc.attachment_name,
          pdc.attachment_url,
          pdc.attachment_cloudinary_public_id,
          pdc.created_by,
          u.username as created_by_username,
          pdc.created_at,
          pdc.updated_at
        FROM post_dated_cheques pdc
        LEFT JOIN users u ON pdc.created_by = u.id
        WHERE pdc.id = ?
      `, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      return this.formatDates(result.rows[0]);
    } catch (error) {
      throw error;
    }
  }

  // Create a new PDC
  static async create(pdcData) {
    try {
      const { chequeDate, chequeNumber, customerName, amount, chequeType, pdcType, description, createdBy } = pdcData;

      const result = await pool.query(
        `INSERT INTO post_dated_cheques 
         (cheque_date, cheque_number, customer_name, amount, cheque_type, pdc_type, description, created_by) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          chequeDate,
          chequeNumber,
          customerName,
          amount,
          chequeType,
          pdcType,
          description || null,
          createdBy || null
        ]
      );
      const fetchResult = await pool.query(
        `SELECT id, cheque_date, cheque_number, customer_name, amount, cheque_type, pdc_type, description,
          daily_ledger_approved, attachment_name, attachment_url, attachment_cloudinary_public_id, created_by, created_at, updated_at
          FROM post_dated_cheques WHERE id = LAST_INSERT_ID()`
      );

      // Get created_by username if created_by exists
      let createdByUsername = null;
      if (createdBy) {
        const userResult = await pool.query(
          'SELECT username FROM users WHERE id = ?',
          [createdBy]
        );
        if (userResult.rows.length > 0) {
          createdByUsername = userResult.rows[0].username;
        }
      }

      const pdc = fetchResult.rows[0];
      return this.formatDates({
        ...pdc,
        created_by_username: createdByUsername
      });
    } catch (error) {
      throw error;
    }
  }

  // Update a PDC
  static async update(id, pdcData) {
    try {
      const { chequeDate, chequeNumber, customerName, amount, chequeType, pdcType, description } = pdcData;

      const updateResult = await pool.query(
        `UPDATE post_dated_cheques 
         SET cheque_date = ?, cheque_number = ?, customer_name = ?, 
             amount = ?, cheque_type = ?, pdc_type = ?, description = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          chequeDate,
          chequeNumber,
          customerName,
          amount,
          chequeType,
          pdcType,
          description || null,
          id
        ]
      );

      if (updateResult.affectedRows === 0) {
        return null;
      }

      const fetchResult = await pool.query(
        `SELECT id, cheque_date, cheque_number, customer_name, amount, cheque_type, pdc_type, description,
          daily_ledger_approved, attachment_name, attachment_url, attachment_cloudinary_public_id, created_by, created_at, updated_at
          FROM post_dated_cheques WHERE id = ?`,
        [id]
      );
      const pdc = fetchResult.rows[0];
      if (!pdc) return null;

      // Get created_by username if created_by exists
      let createdByUsername = null;
      if (pdc.created_by) {
        const userResult = await pool.query(
          'SELECT username FROM users WHERE id = ?',
          [pdc.created_by]
        );
        if (userResult.rows.length > 0) {
          createdByUsername = userResult.rows[0].username;
        }
      }
      return this.formatDates({
        ...pdc,
        created_by_username: createdByUsername
      });
    } catch (error) {
      throw error;
    }
  }

  /** Mark matured GCEC/Custom PDC as approved on the daily ledger (hides pending footer duplicate). */
  static async setDailyLedgerApproved(id, approved) {
    try {
      const v = approved ? 1 : 0;
      const updateResult = await pool.query(
        `UPDATE post_dated_cheques 
         SET daily_ledger_approved = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [v, id]
      );
      if (updateResult.affectedRows === 0) {
        return null;
      }
      return await this.getById(id);
    } catch (error) {
      throw error;
    }
  }

  /** Set cheque scan (Cloudinary); does not alter other fields */
  static async setChequeAttachment(id, { attachmentName, attachmentUrl, attachmentCloudinaryPublicId }) {
    try {
      const updateResult = await pool.query(
        `UPDATE post_dated_cheques 
         SET attachment_name = ?, attachment_url = ?, attachment_cloudinary_public_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [attachmentName, attachmentUrl, attachmentCloudinaryPublicId, id]
      );
      if (updateResult.affectedRows === 0) {
        return null;
      }
      return await this.getById(id);
    } catch (error) {
      throw error;
    }
  }

  // Delete a PDC
  static async delete(id) {
    try {
      const result = await pool.query(
        'DELETE FROM post_dated_cheques WHERE id = ?',
        [id]
      );

      return result.affectedRows > 0;
    } catch (error) {
      throw error;
    }
  }

  // Get PDCs near cheque date (for dashboard reminders)
  // Returns PDCs whose cheque_date is within the specified days range (includes both GCEC PDC and Customer PDC)
  // Only includes future dates (upcoming cheques) - expired dates are automatically excluded
  static async getNearChequeDate(days = 30) {
    try {
      // Use PostgreSQL's CURRENT_DATE and INTERVAL for proper date arithmetic
      // This avoids timezone issues by using database server's date
      // Only include future dates (cheque_date >= CURRENT_DATE) to exclude expired notifications
      const result = await pool.query(`
        SELECT 
          pdc.id,
          DATE_FORMAT(pdc.cheque_date, '%Y-%m-%d') as cheque_date,
          pdc.cheque_number,
          pdc.customer_name,
          pdc.amount,
          pdc.cheque_type,
          pdc.pdc_type,
          pdc.description,
          pdc.daily_ledger_approved,
          pdc.attachment_name,
          pdc.attachment_url,
          pdc.attachment_cloudinary_public_id,
          pdc.created_by,
          u.username as created_by_username,
          pdc.created_at,
          pdc.updated_at,
          DATEDIFF(pdc.cheque_date, CURDATE()) as days_remaining
        FROM post_dated_cheques pdc
        LEFT JOIN users u ON pdc.created_by = u.id
        WHERE pdc.pdc_type IN ('GCEC PDC', 'Customer PDC')
          AND pdc.cheque_date >= CURRENT_DATE
          AND pdc.cheque_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
        ORDER BY pdc.cheque_date ASC, pdc.created_at ASC
      `, [days]);
      
      // Format dates and return results
      return result.rows.map(row => this.formatDates(row));
    } catch (error) {
      console.error('Error in getNearChequeDate:', error);
      throw error;
    }
  }
}

module.exports = PDC;

