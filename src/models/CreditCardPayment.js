const { pool } = require('../config/database');

const VALID_PAYMENT_TYPES = ['paid', 'epp'];

class CreditCardPayment {
  // Get all credit card payments
  static async getAll(filters = {}) {
    try {
      const { year, months, paidAgainst, paymentType } = filters;
      const whereClauses = [];
      const params = [];

      if (year !== undefined && year !== null && String(year).trim() !== '') {
        whereClauses.push('YEAR(ccp.payment_date) = ?');
        params.push(Number(year));
      }

      if (months !== undefined && months !== null && String(months).trim() !== '') {
        whereClauses.push('MONTH(ccp.payment_date) = ?');
        params.push(Number(months));
      }

      if (paidAgainst !== undefined && paidAgainst !== null && String(paidAgainst).trim() !== '') {
        whereClauses.push('ccp.paid_against = ?');
        params.push(String(paidAgainst).trim());
      }

      if (paymentType !== undefined && paymentType !== null && String(paymentType).trim() !== '') {
        whereClauses.push('ccp.payment_type = ?');
        params.push(String(paymentType).trim().toLowerCase());
      }

      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const result = await pool.query(`
        SELECT 
          ccp.id,
          DATE_FORMAT(ccp.payment_date, '%Y-%m-%d') AS payment_date,
          ccp.credit_card_id,
          ccp.customer_name,
          ccp.payment_method,
          ccp.payment_type,
          ccp.amount,
          ccp.remarks,
          ccp.paid_against,
          ccp.created_by,
          u.username as created_by_username,
          ccp.created_at,
          ccp.updated_at,
          c.id as card_id,
          c.issuing_bank,
          c.card_holder,
          c.card_number
        FROM credit_card_payments ccp
        LEFT JOIN users u ON ccp.created_by = u.id
        LEFT JOIN credit_cards_new c ON ccp.credit_card_id = c.id
        ${whereSql}
        ORDER BY ccp.payment_date DESC, ccp.created_at DESC, ccp.id DESC
      `, params);
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
          DATE_FORMAT(ccp.payment_date, '%Y-%m-%d') AS payment_date,
          ccp.credit_card_id,
          ccp.customer_name,
          ccp.payment_method,
          ccp.payment_type,
          ccp.amount,
          ccp.remarks,
          ccp.paid_against,
          ccp.created_by,
          u.username as created_by_username,
          ccp.created_at,
          ccp.updated_at,
          c.id as card_id,
          c.issuing_bank,
          c.card_holder,
          c.card_number
        FROM credit_card_payments ccp
        LEFT JOIN users u ON ccp.created_by = u.id
        LEFT JOIN credit_cards_new c ON ccp.credit_card_id = c.id
        WHERE ccp.id = ?
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
      const { paymentDate, creditCardId, customerName, paymentMethod, paymentType, amount, remarks, paidAgainst, createdBy } = paymentData;

      const result = await pool.query(
        `INSERT INTO credit_card_payments 
         (payment_date, credit_card_id, customer_name, payment_method, payment_type, amount, remarks, paid_against, created_by) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          paymentDate,
          creditCardId || null,
          customerName || null,
          paymentMethod || 'Credit Card',
          paymentType || 'paid',
          amount,
          remarks || null,
          paidAgainst || null,
          createdBy || null
        ]
      );
      const fetchResult = await pool.query(
        `SELECT
          id,
          DATE_FORMAT(payment_date, '%Y-%m-%d') AS payment_date,
          credit_card_id,
          customer_name,
          payment_method,
          payment_type,
          amount,
          remarks,
          paid_against,
          created_by,
          created_at,
          updated_at
        FROM credit_card_payments
        WHERE id = LAST_INSERT_ID()`
      );

      // Get card details and created_by username
      let cardDetails = null;
      let createdByUsername = null;

      if (creditCardId) {
        const cardResult = await pool.query(
          'SELECT id, issuing_bank, card_holder, card_number FROM credit_cards_new WHERE id = ?',
          [creditCardId]
        );
        if (cardResult.rows.length > 0) {
          cardDetails = cardResult.rows[0];
        }
      }

      if (createdBy) {
        const userResult = await pool.query(
          'SELECT username FROM users WHERE id = ?',
          [createdBy]
        );
        if (userResult.rows.length > 0) {
          createdByUsername = userResult.rows[0].username;
        }
      }

      const payment = fetchResult.rows[0];
      return {
        ...payment,
        card_id: cardDetails?.id || null,
        issuing_bank: cardDetails?.issuing_bank || null,
        card_holder: cardDetails?.card_holder || null,
        card_number: cardDetails?.card_number || null,
        created_by_username: createdByUsername
      };
    } catch (error) {
      throw error;
    }
  }

  // Update a credit card payment
  static async update(id, paymentData) {
    try {
      const { paymentDate, creditCardId, customerName, paymentMethod, paymentType, amount, remarks, paidAgainst } = paymentData;

      const updateFields = [];
      const values = [];

      if (paymentDate !== undefined) { updateFields.push('payment_date = ?'); values.push(paymentDate); }
      if (creditCardId !== undefined) { updateFields.push('credit_card_id = ?'); values.push(creditCardId || null); }
      if (customerName !== undefined) { updateFields.push('customer_name = ?'); values.push(customerName || null); }
      if (paymentMethod !== undefined) { updateFields.push('payment_method = ?'); values.push(paymentMethod || 'Credit Card'); }
      if (paymentType !== undefined) { updateFields.push('payment_type = ?'); values.push(paymentType || 'paid'); }
      if (amount !== undefined) { updateFields.push('amount = ?'); values.push(amount); }
      if (remarks !== undefined) { updateFields.push('remarks = ?'); values.push(remarks || null); }
      if (paidAgainst !== undefined) { updateFields.push('paid_against = ?'); values.push(paidAgainst || null); }

      if (updateFields.length === 0) return await this.getById(id);

      updateFields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);

      const updateResult = await pool.query(
        `UPDATE credit_card_payments SET ${updateFields.join(', ')} WHERE id = ?`,
        values
      );
      if (updateResult.affectedRows === 0) return null;

      const payment = await this.getById(id);
      if (!payment) return null;
      let cardDetails = null;
      let createdByUsername = null;

      if (payment.credit_card_id) {
        const cardResult = await pool.query(
          'SELECT id, issuing_bank, card_holder, card_number FROM credit_cards_new WHERE id = ?',
          [payment.credit_card_id]
        );
        if (cardResult.rows.length > 0) {
          cardDetails = cardResult.rows[0];
        }
      }

      if (payment.created_by) {
        const userResult = await pool.query(
          'SELECT username FROM users WHERE id = ?',
          [payment.created_by]
        );
        if (userResult.rows.length > 0) {
          createdByUsername = userResult.rows[0].username;
        }
      }

      return {
        ...payment,
        card_id: cardDetails?.id || null,
        issuing_bank: cardDetails?.issuing_bank || null,
        card_holder: cardDetails?.card_holder || null,
        card_number: cardDetails?.card_number || null,
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
        'DELETE FROM credit_card_payments WHERE id = ?',
        [id]
      );

      return result.affectedRows > 0;
    } catch (error) {
      throw error;
    }
  }
}

CreditCardPayment.VALID_PAYMENT_TYPES = VALID_PAYMENT_TYPES;

module.exports = CreditCardPayment;
