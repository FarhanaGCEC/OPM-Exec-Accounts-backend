const { pool } = require('../config/database');
const { randomUUID } = require('crypto');

class Card {
  /** Prefer full card_number when both exist (some DBs used card_number_last4 only). */
  static async _cardNumberColumnName() {
    try {
      const result = await pool.query(`
        SELECT column_name
        FROM information_schema.columns 
        WHERE table_schema = DATABASE() AND table_name = 'credit_cards_new' 
        AND column_name IN ('card_number', 'card_number_last4')
        ORDER BY (column_name = 'card_number') DESC
        LIMIT 1
      `);
      if (!result.rows.length) return 'card_number';
      const row = result.rows[0];
      const name = row.column_name ?? row.COLUMN_NAME;
      if (name === 'card_number' || name === 'card_number_last4') return name;
    } catch (e) {
      // Shared hosting often blocks information_schema; /api/credit-cards still works without it.
      console.warn('Card._cardNumberColumnName: falling back to card_number (%s)', e.message);
    }
    return 'card_number';
  }

  // Get all cards (optionally filter by is_active)
  static async getAll(includeInactive = false) {
    try {
      const cardNumberColumn = await this._cardNumberColumnName();

      let query = `
        SELECT 
          id,
          issuing_bank,
          card_holder,
          \`${cardNumberColumn}\` AS card_number,
          expiry_date,
          credit_limit,
          billing_cycle_days,
          statement_day,
          display_order,
          is_active,
          created_at,
          updated_at
        FROM credit_cards_new
      `;
      
      if (!includeInactive) {
        query += ` WHERE is_active = 1`;
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
      const cardNumberColumn = await this._cardNumberColumnName();
      const result = await pool.query(
        `SELECT 
          id,
          issuing_bank,
          card_holder,
          \`${cardNumberColumn}\` AS card_number,
          expiry_date,
          credit_limit,
          billing_cycle_days,
          statement_day,
          display_order,
          is_active,
          created_at,
          updated_at
        FROM credit_cards_new
        WHERE id = ?`,
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
      const { issuingBank, cardHolder, cardNumber, expiryDate, creditLimit, billingCycleDays, isActive } = cardData;
      const id = randomUUID();

      await pool.query(
        `INSERT INTO credit_cards_new 
         (id, issuing_bank, card_holder, card_number, expiry_date, credit_limit, billing_cycle_days, is_active) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          issuingBank,
          cardHolder,
          cardNumber,
          expiryDate,
          creditLimit || null,
          billingCycleDays !== undefined ? billingCycleDays : 25,
          isActive !== undefined ? (isActive ? 1 : 0) : 1
        ]
      );

      return (await this.getById(id));
    } catch (error) {
      throw error;
    }
  }

  // Update card
  static async update(id, cardData) {
    try {
      const { issuingBank, cardHolder, cardNumber, expiryDate, creditLimit, billingCycleDays, isActive } = cardData;

      const fields = [];
      const values = [];

      if (issuingBank !== undefined) { fields.push('issuing_bank = ?'); values.push(issuingBank); }
      if (cardHolder !== undefined) { fields.push('card_holder = ?'); values.push(cardHolder); }
      if (cardNumber !== undefined) { fields.push('card_number = ?'); values.push(cardNumber); }
      if (expiryDate !== undefined) { fields.push('expiry_date = ?'); values.push(expiryDate); }
      if (creditLimit !== undefined) { fields.push('credit_limit = ?'); values.push(creditLimit); }
      if (billingCycleDays !== undefined) { fields.push('billing_cycle_days = ?'); values.push(billingCycleDays); }
      if (isActive !== undefined) { fields.push('is_active = ?'); values.push(isActive ? 1 : 0); }

      if (fields.length === 0) return await this.getById(id);

      fields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);

      const updateResult = await pool.query(
        `UPDATE credit_cards_new SET ${fields.join(', ')} WHERE id = ?`,
        values
      );
      if (updateResult.affectedRows === 0) return null;
      return await this.getById(id);
    } catch (error) {
      throw error;
    }
  }

  // Delete (deactivate) card
  static async deactivate(id) {
    try {
      const result = await pool.query(
        `UPDATE credit_cards_new SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [id]
      );
      if (result.affectedRows === 0) return null;
      return await this.getById(id);
    } catch (error) {
      throw error;
    }
  }

  // Activate card
  static async activate(id) {
    try {
      const result = await pool.query(
        `UPDATE credit_cards_new SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [id]
      );
      if (result.affectedRows === 0) return null;
      return await this.getById(id);
    } catch (error) {
      throw error;
    }
  }

  // Get all active cards
  static async getActiveCards() {
    try {
      const cardNumberColumn = await this._cardNumberColumnName();
      const result = await pool.query(
        `SELECT id, issuing_bank, card_holder, \`${cardNumberColumn}\` AS card_number, billing_cycle_days, statement_day 
         FROM credit_cards_new 
         WHERE is_active = 1 
         ORDER BY display_order ASC, issuing_bank ASC`
      );
      return result.rows;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Card;
