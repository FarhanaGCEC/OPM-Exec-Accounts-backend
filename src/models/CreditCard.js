const { pool } = require('../config/database');

class CreditCard {
  // Get all credit cards
  static async getAll() {
    try {
      const result = await pool.query(`
        SELECT 
          cc.id,
          cc.issuing_bank,
          cc.card_holder,
          cc.card_number,
          cc.expiry,
          cc.cvv,
          cc.amount_limit,
          cc.is_system,
          cc.is_default,
          cc.created_at,
          cc.updated_at
        FROM credit_cards cc
        ORDER BY cc.is_system DESC, cc.is_default DESC, cc.created_at ASC
      `);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get a single credit card by ID
  static async getById(id) {
    try {
      const result = await pool.query(`
        SELECT 
          cc.id,
          cc.issuing_bank,
          cc.card_holder,
          cc.card_number,
          cc.expiry,
          cc.cvv,
          cc.amount_limit,
          cc.is_system,
          cc.is_default,
          cc.created_at,
          cc.updated_at
        FROM credit_cards cc
        WHERE cc.id = ?
      `, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Create a new credit card
  static async create(cardData) {
    try {
      const { issuingBank, cardHolder, cardNumber, expiry, cvv, amountLimit, isSystem, isDefault } = cardData;

      const result = await pool.query(
        `INSERT INTO credit_cards 
         (issuing_bank, card_holder, card_number, expiry, cvv, amount_limit, is_system, is_default) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          issuingBank,
          cardHolder,
          cardNumber,
          expiry,
          cvv || null,
          amountLimit || null,
          isSystem ? 1 : 0,
          isDefault ? 1 : 0
        ]
      );
      const fetchResult = await pool.query(
        'SELECT id, issuing_bank, card_holder, card_number, expiry, cvv, amount_limit, is_system, is_default, created_at, updated_at FROM credit_cards WHERE id = LAST_INSERT_ID()'
      );
      return fetchResult.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Update a credit card
  static async update(id, cardData) {
    try {
      const { issuingBank, cardHolder, cardNumber, expiry, cvv, amountLimit, isDefault } = cardData;

      // Check if card is system card - if so, prevent modification of is_system field
      const existingCard = await this.getById(id);
      if (!existingCard) {
        return null;
      }

      // System cards cannot be modified (except through database directly)
      // Only allow updating non-system cards or allow updates but preserve is_system flag
      
      const result = await pool.query(
        `UPDATE credit_cards 
         SET issuing_bank = ?, card_holder = ?, card_number = ?, 
             expiry = ?, cvv = ?, amount_limit = ?, is_default = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          issuingBank,
          cardHolder,
          cardNumber,
          expiry,
          cvv || null,
          amountLimit || null,
          isDefault !== undefined ? isDefault : existingCard.is_default,
          id
        ]
      );

      if (result.affectedRows === 0) return null;
      return await this.getById(id);
    } catch (error) {
      throw error;
    }
  }

  // Delete a credit card (only if not a system card)
  static async delete(id) {
    try {
      // Check if card is system card
      const card = await this.getById(id);
      if (!card) {
        return false;
      }

      if (card.is_system) {
        throw new Error('Cannot delete system credit card');
      }

      const result = await pool.query(
        'DELETE FROM credit_cards WHERE id = ?',
        [id]
      );

      return result.affectedRows > 0;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = CreditCard;
