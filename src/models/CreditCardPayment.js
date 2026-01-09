const { pool } = require('../config/database');

class CreditCardPayment {
  // Get all credit card payments
  static async getAll() {
    try {
      const result = await pool.query(`
        SELECT 
          ccp.id,
          ccp.payment_date,
          ccp.credit_card_id,
          ccp.customer_name,
          ccp.payment_method,
          ccp.amount,
          ccp.remarks,
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
        ORDER BY ccp.payment_date DESC, ccp.created_at DESC
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
          ccp.credit_card_id,
          ccp.customer_name,
          ccp.payment_method,
          ccp.amount,
          ccp.remarks,
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
      const { paymentDate, creditCardId, customerName, paymentMethod, amount, remarks, createdBy } = paymentData;

      const result = await pool.query(
        `INSERT INTO credit_card_payments 
         (payment_date, credit_card_id, customer_name, payment_method, amount, remarks, created_by) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) 
         RETURNING id, payment_date, credit_card_id, customer_name, payment_method, amount, remarks, created_by, created_at, updated_at`,
        [
          paymentDate,
          creditCardId || null,
          customerName || null,
          paymentMethod || 'Credit Card',
          amount,
          remarks || null,
          createdBy || null
        ]
      );

      // Get card details and created_by username
      let cardDetails = null;
      let createdByUsername = null;

      if (creditCardId) {
        const cardResult = await pool.query(
          'SELECT id, issuing_bank, card_holder, card_number FROM credit_cards_new WHERE id = $1',
          [creditCardId]
        );
        if (cardResult.rows.length > 0) {
          cardDetails = cardResult.rows[0];
        }
      }

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
      const { paymentDate, creditCardId, customerName, paymentMethod, amount, remarks } = paymentData;

      const updateFields = [];
      const values = [];
      let paramCount = 0;

      if (paymentDate !== undefined) {
        paramCount++;
        updateFields.push(`payment_date = $${paramCount}`);
        values.push(paymentDate);
      }

      if (creditCardId !== undefined) {
        paramCount++;
        updateFields.push(`credit_card_id = $${paramCount}`);
        values.push(creditCardId || null);
      }

      if (customerName !== undefined) {
        paramCount++;
        updateFields.push(`customer_name = $${paramCount}`);
        values.push(customerName || null);
      }

      if (paymentMethod !== undefined) {
        paramCount++;
        updateFields.push(`payment_method = $${paramCount}`);
        values.push(paymentMethod || 'Credit Card');
      }

      if (amount !== undefined) {
        paramCount++;
        updateFields.push(`amount = $${paramCount}`);
        values.push(amount);
      }

      if (remarks !== undefined) {
        paramCount++;
        updateFields.push(`remarks = $${paramCount}`);
        values.push(remarks || null);
      }

      if (updateFields.length === 0) {
        return await this.getById(id);
      }

      paramCount++;
      updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id);

      const result = await pool.query(
        `UPDATE credit_card_payments 
         SET ${updateFields.join(', ')}
         WHERE id = $${paramCount}
         RETURNING id, payment_date, credit_card_id, customer_name, payment_method, amount, remarks, created_by, created_at, updated_at`,
        values
      );

      if (result.rows.length === 0) {
        return null;
      }

      // Get card details and created_by username
      const payment = result.rows[0];
      let cardDetails = null;
      let createdByUsername = null;

      if (payment.credit_card_id) {
        const cardResult = await pool.query(
          'SELECT id, issuing_bank, card_holder, card_number FROM credit_cards_new WHERE id = $1',
          [payment.credit_card_id]
        );
        if (cardResult.rows.length > 0) {
          cardDetails = cardResult.rows[0];
        }
      }

      if (payment.created_by) {
        const userResult = await pool.query(
          'SELECT username FROM users WHERE id = $1',
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







