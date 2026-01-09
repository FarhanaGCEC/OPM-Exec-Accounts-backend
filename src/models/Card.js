const { pool } = require('../config/database');

class Card {
  // Get all cards (optionally filter by is_active)
  static async getAll(includeInactive = false) {
    try {
      // Check which column name exists and use it
      const columnCheck = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'credit_cards_new' 
        AND column_name IN ('card_number', 'card_number_last4')
        LIMIT 1
      `);
      
      const cardNumberColumn = columnCheck.rows.length > 0 
        ? columnCheck.rows[0].column_name 
        : 'card_number'; // Default to new column name

      let query = `
        SELECT 
          id,
          issuing_bank,
          card_holder,
          ${cardNumberColumn} as card_number,
          expiry_date,
          credit_limit,
          billing_cycle_days,
          statement_day,
          is_active,
          created_at,
          updated_at
        FROM credit_cards_new
      `;
      
      if (!includeInactive) {
        query += ` WHERE is_active = TRUE`;
      }
      
      query += ` ORDER BY display_order ASC, is_active DESC, issuing_bank ASC`;

      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      console.error('Card.getAll error:', error.message);
      throw error;
    }
  }

  // Get card by ID
  static async getById(id) {
    try {
      const result = await pool.query(
        `SELECT 
          id,
          issuing_bank,
          card_holder,
          card_number,
          expiry_date,
          credit_limit,
          billing_cycle_days,
          statement_day,
          display_order,
          is_active,
          created_at,
          updated_at
        FROM credit_cards_new
        WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Create new card
  static async create(cardData) {
    try {
      const { issuingBank, cardHolder, cardNumber, expiryDate, creditLimit, isActive } = cardData;

      const result = await pool.query(
        `INSERT INTO credit_cards_new 
         (issuing_bank, card_holder, card_number, expiry_date, credit_limit, billing_cycle_days, is_active) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) 
         RETURNING id, issuing_bank, card_holder, card_number, expiry_date, credit_limit, billing_cycle_days, is_active, created_at, updated_at`,
        [
          issuingBank,
          cardHolder,
          cardNumber,
          expiryDate,
          creditLimit || null,
          billingCycleDays || 25,
          isActive !== undefined ? isActive : true
        ]
      );

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Update card
  static async update(id, cardData) {
    try {
      const { issuingBank, cardHolder, cardNumber, expiryDate, creditLimit, isActive } = cardData;

      const fields = [];
      const values = [];
      let paramCount = 0;

      if (issuingBank !== undefined) {
        paramCount++;
        fields.push(`issuing_bank = $${paramCount}`);
        values.push(issuingBank);
      }

      if (cardHolder !== undefined) {
        paramCount++;
        fields.push(`card_holder = $${paramCount}`);
        values.push(cardHolder);
      }

      if (cardNumber !== undefined) {
        paramCount++;
        fields.push(`card_number = $${paramCount}`);
        values.push(cardNumber);
      }

      if (expiryDate !== undefined) {
        paramCount++;
        fields.push(`expiry_date = $${paramCount}`);
        values.push(expiryDate);
      }

      if (creditLimit !== undefined) {
        paramCount++;
        fields.push(`credit_limit = $${paramCount}`);
        values.push(creditLimit);
      }

      if (billingCycleDays !== undefined) {
        paramCount++;
        fields.push(`billing_cycle_days = $${paramCount}`);
        values.push(billingCycleDays);
      }

      if (isActive !== undefined) {
        paramCount++;
        fields.push(`is_active = $${paramCount}`);
        values.push(isActive);
      }

      if (fields.length === 0) {
        return await this.getById(id);
      }

      paramCount++;
      fields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id);

      const query = `
        UPDATE credit_cards_new 
        SET ${fields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING id, issuing_bank, card_holder, card_number, expiry_date, credit_limit, billing_cycle_days, is_active, created_at, updated_at
      `;

      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Delete (deactivate) card
  static async deactivate(id) {
    try {
      const result = await pool.query(
        `UPDATE credit_cards_new 
         SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id, issuing_bank, card_holder, card_number, expiry_date, credit_limit, billing_cycle_days, is_active, created_at, updated_at`,
        [id]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Get all active cards
  static async getActiveCards() {
    try {
      const result = await pool.query(
        `SELECT id, issuing_bank, card_holder, card_number, billing_cycle_days, statement_day 
         FROM credit_cards_new 
         WHERE is_active = TRUE 
         ORDER BY display_order ASC, issuing_bank ASC`
      );
      return result.rows;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Card;
