const { pool } = require('../config/database');

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
    return formatted;
  }

  // Get all post-dated cheques
  static async getAll() {
    try {
      const result = await pool.query(`
        SELECT 
          pdc.id,
          pdc.cheque_date::text as cheque_date,
          pdc.cheque_number,
          pdc.customer_name,
          pdc.amount,
          pdc.cheque_type,
          pdc.pdc_type,
          pdc.description,
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
          pdc.cheque_date::text as cheque_date,
          pdc.cheque_number,
          pdc.customer_name,
          pdc.amount,
          pdc.cheque_type,
          pdc.pdc_type,
          pdc.description,
          pdc.created_by,
          u.username as created_by_username,
          pdc.created_at,
          pdc.updated_at
        FROM post_dated_cheques pdc
        LEFT JOIN users u ON pdc.created_by = u.id
        WHERE pdc.id = $1
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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
         RETURNING id, cheque_date::text as cheque_date, cheque_number, customer_name, amount, cheque_type, pdc_type, description, created_by, created_at, updated_at`,
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

      // Get created_by username if created_by exists
      let createdByUsername = null;
      if (createdBy) {
        const userResult = await pool.query(
          'SELECT username FROM users WHERE id = $1',
          [createdBy]
        );
        if (userResult.rows.length > 0) {
          createdByUsername = userResult.rows[0].username;
        }
      }

      const pdc = result.rows[0];
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

      const result = await pool.query(
        `UPDATE post_dated_cheques 
         SET cheque_date = $1, cheque_number = $2, customer_name = $3, 
             amount = $4, cheque_type = $5, pdc_type = $6, description = $7, updated_at = CURRENT_TIMESTAMP
         WHERE id = $8
         RETURNING id, cheque_date::text as cheque_date, cheque_number, customer_name, amount, cheque_type, pdc_type, description, created_by, created_at, updated_at`,
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

      if (result.rows.length === 0) {
        return null;
      }

      // Get created_by username if created_by exists
      let createdByUsername = null;
      if (result.rows[0].created_by) {
        const userResult = await pool.query(
          'SELECT username FROM users WHERE id = $1',
          [result.rows[0].created_by]
        );
        if (userResult.rows.length > 0) {
          createdByUsername = userResult.rows[0].username;
        }
      }

      const pdc = result.rows[0];
      return this.formatDates({
        ...pdc,
        created_by_username: createdByUsername
      });
    } catch (error) {
      throw error;
    }
  }

  // Delete a PDC
  static async delete(id) {
    try {
      const result = await pool.query(
        'DELETE FROM post_dated_cheques WHERE id = $1 RETURNING id',
        [id]
      );

      return result.rows.length > 0;
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
          pdc.cheque_date::text as cheque_date,
          pdc.cheque_number,
          pdc.customer_name,
          pdc.amount,
          pdc.cheque_type,
          pdc.pdc_type,
          pdc.description,
          pdc.created_by,
          u.username as created_by_username,
          pdc.created_at,
          pdc.updated_at,
          (pdc.cheque_date - CURRENT_DATE)::INTEGER as days_remaining
        FROM post_dated_cheques pdc
        LEFT JOIN users u ON pdc.created_by = u.id
        WHERE pdc.pdc_type IN ('GCEC PDC', 'Customer PDC')
          AND pdc.cheque_date >= CURRENT_DATE
          AND pdc.cheque_date <= CURRENT_DATE + (INTERVAL '1 day' * $1)
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

