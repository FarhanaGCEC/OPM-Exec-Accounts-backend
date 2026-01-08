const { pool } = require('../config/database');

class CreditCardPayment {
  // Get all credit card payments
  static async getAll() {
    try {
      const result = await pool.query(`
        SELECT 
          ccp.id,
          ccp.payment_date,
          ccp.customer_name,
          ccp.payment_method,
          ccp.amount,
          ccp.created_by,
          u.username as created_by_username,
          ccp.created_at,
          ccp.updated_at
        FROM credit_card_payments ccp
        LEFT JOIN users u ON ccp.created_by = u.id
        ORDER BY ccp.payment_date ASC, ccp.created_at ASC
      `);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get a single credit card payment by ID
  static async getById(id) {
    try {
      const result = await pool.query(`
        SELECT 
          ccp.id,
          ccp.payment_date,
          ccp.customer_name,
          ccp.payment_method,
          ccp.amount,
          ccp.created_by,
          u.username as created_by_username,
          ccp.created_at,
          ccp.updated_at
        FROM credit_card_payments ccp
        LEFT JOIN users u ON ccp.created_by = u.id
        WHERE ccp.id = $1
      `, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Create a new credit card payment
  static async create(paymentData) {
    try {
      const { paymentDate, customerName, paymentMethod, amount, createdBy } = paymentData;

      const result = await pool.query(
        `INSERT INTO credit_card_payments 
         (payment_date, customer_name, payment_method, amount, created_by) 
         VALUES ($1, $2, $3, $4, $5) 
         RETURNING id, payment_date, customer_name, payment_method, amount, created_by, created_at, updated_at`,
        [
          paymentDate,
          customerName,
          paymentMethod || 'Credit Card',
          amount,
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

      const payment = result.rows[0];
      return {
        ...payment,
        created_by_username: createdByUsername
      };
    } catch (error) {
      throw error;
    }
  }

  // Update a credit card payment
  static async update(id, paymentData) {
    try {
      const { paymentDate, customerName, paymentMethod, amount } = paymentData;

      const result = await pool.query(
        `UPDATE credit_card_payments 
         SET payment_date = $1, customer_name = $2, payment_method = $3, 
             amount = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $5
         RETURNING id, payment_date, customer_name, payment_method, amount, created_by, created_at, updated_at`,
        [
          paymentDate,
          customerName,
          paymentMethod || 'Credit Card',
          amount,
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

      const payment = result.rows[0];
      return {
        ...payment,
        created_by_username: createdByUsername
      };
    } catch (error) {
      throw error;
    }
  }

  // Delete a credit card payment
  static async delete(id) {
    try {
      const result = await pool.query(
        'DELETE FROM credit_card_payments WHERE id = $1 RETURNING id',
        [id]
      );

      return result.rows.length > 0;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = CreditCardPayment;







