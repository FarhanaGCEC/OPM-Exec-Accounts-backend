const { pool } = require('../config/database');
const { randomUUID } = require('crypto');

class Statement {
  // Get all statements (optionally filter by month, card_id)
  // If month is provided and includeAllCards is true, returns all cards even without statements
  static async getAll(filters = {}) {
    try {
      const { month, cardId, includeAllCards = false } = filters;
      
      if (month && includeAllCards) {
        // Return ALL cards for the month, with LEFT JOIN to include cards without statements
        let query = `
          SELECT 
            s.id,
            s.credit_card_id,
            s.statement_month,
            s.statement_date,
            s.due_date,
            s.days,
            s.due_month,
            s.total_due,
            s.paid_amount,
            s.pending_amount,
            s.epp_balance,
            s.balance_transfer,
            s.payment_status,
            s.created_at,
            s.updated_at,
            c.id as card_id,
            c.issuing_bank,
            c.card_holder,
            c.card_number,
            c.expiry_date,
            c.credit_limit,
            c.billing_cycle_days,
            c.statement_day,
            c.display_order,
            c.is_active
          FROM credit_cards_new c
          LEFT JOIN card_statements s ON c.id = s.credit_card_id AND s.statement_month = ?
          WHERE c.is_active = 1
        `;
        const params = [month];

        if (cardId) {
          query += ` AND c.id = ?`;
          params.push(cardId);
        }

        query += ` ORDER BY c.display_order ASC, COALESCE(s.statement_date, '1970-01-01') ASC, c.issuing_bank ASC`;

        const result = await pool.query(query, params);
        return result.rows;
      } else {
        // Original query: only return cards that have statements
        let query = `
          SELECT 
            s.id,
            s.credit_card_id,
            s.statement_month,
            s.statement_date,
            s.due_date,
            s.days,
            s.due_month,
            s.total_due,
            s.paid_amount,
            s.pending_amount,
            s.epp_balance,
            s.balance_transfer,
            s.payment_status,
            s.created_at,
            s.updated_at,
            c.id as card_id,
            c.issuing_bank,
            c.card_holder,
            c.card_number,
            c.expiry_date,
            c.credit_limit,
            c.is_active
          FROM card_statements s
          INNER JOIN credit_cards_new c ON s.credit_card_id = c.id
          WHERE 1=1
        `;
        const params = [];

        if (month) {
          query += ` AND s.statement_month = ?`;
          params.push(month);
        }

        if (cardId) {
          query += ` AND s.credit_card_id = ?`;
          params.push(cardId);
        }

        query += ` ORDER BY c.display_order ASC, s.statement_date ASC, c.issuing_bank ASC`;

        const result = await pool.query(query, params);
        return result.rows;
      }
    } catch (error) {
      throw error;
    }
  }

  // Get statement by ID
  static async getById(id) {
    try {
      const result = await pool.query(
        `SELECT 
          s.id,
          s.credit_card_id,
          s.statement_month,
          s.statement_date,
          s.due_date,
          s.days,
          s.due_month,
          s.total_due,
          s.paid_amount,
          s.pending_amount,
          s.epp_balance,
          s.balance_transfer,
          s.payment_status,
          s.created_at,
          s.updated_at,
          c.id as card_id,
          c.issuing_bank,
          c.card_holder,
          c.card_number,
          c.expiry_date,
          c.credit_limit,
          c.billing_cycle_days,
          c.statement_day,
          c.is_active
        FROM card_statements s
        INNER JOIN credit_cards_new c ON s.credit_card_id = c.id
        WHERE s.id = ?`,
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

  // Get statement by card_id and month
  static async getByCardIdAndMonth(cardId, statementMonth) {
    try {
      const result = await pool.query(
        `SELECT 
          s.id,
          s.credit_card_id,
          s.statement_month,
          s.statement_date,
          s.due_date,
          s.days,
          s.due_month,
          s.total_due,
          s.paid_amount,
          s.pending_amount,
          s.epp_balance,
          s.balance_transfer,
          s.payment_status,
          s.created_at,
          s.updated_at,
          c.id as card_id,
          c.issuing_bank,
          c.card_holder,
          c.card_number,
          c.expiry_date,
          c.credit_limit,
          c.billing_cycle_days,
          c.statement_day,
          c.is_active
        FROM card_statements s
        INNER JOIN credit_cards_new c ON s.credit_card_id = c.id
        WHERE s.credit_card_id = ? AND s.statement_month = ?`,
        [cardId, statementMonth]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Create statement
  static async create(statementData) {
    try {
      const {
        creditCardId,
        statementMonth,
        statementDate,
        dueDate,
        days,
        dueMonth,
        totalDue,
        paidAmount,
        pendingAmount,
        eppBalance,
        balanceTransfer,
        paymentStatus
      } = statementData;

      const id = randomUUID();
      await pool.query(
        `INSERT INTO card_statements 
         (id, credit_card_id, statement_month, statement_date, due_date, days, due_month, total_due, paid_amount, 
          pending_amount, epp_balance, balance_transfer, payment_status) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          creditCardId,
          statementMonth,
          statementDate,
          dueDate,
          days || 25,
          dueMonth || null,
          totalDue || 0,
          paidAmount || 0,
          pendingAmount || 0,
          eppBalance || 0,
          balanceTransfer || 0,
          paymentStatus || 'PARTIAL'
        ]
      );

      const fetchResult = await pool.query(
        'SELECT id, credit_card_id, statement_month, statement_date, due_date, days, due_month, total_due, paid_amount, pending_amount, epp_balance, balance_transfer, payment_status, created_at, updated_at FROM card_statements WHERE id = ?',
        [id]
      );
      const statement = fetchResult.rows[0];
      if (!statement) return null;

      // Get card details
      const cardResult = await pool.query(
        'SELECT id, issuing_bank, card_holder, card_number, expiry_date, credit_limit, is_active FROM credit_cards_new WHERE id = ?',
        [creditCardId]
      );
      if (cardResult.rows.length > 0) {
        statement.card_id = cardResult.rows[0].id;
        statement.issuing_bank = cardResult.rows[0].issuing_bank;
        statement.card_holder = cardResult.rows[0].card_holder;
        statement.card_number = cardResult.rows[0].card_number;
        statement.expiry_date = cardResult.rows[0].expiry_date;
        statement.credit_limit = cardResult.rows[0].credit_limit;
        statement.is_active = cardResult.rows[0].is_active;
      }

      return statement;
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new Error('Statement already exists for this card and month');
      }
      throw error;
    }
  }

  // Update statement
  static async update(id, statementData) {
    try {
      const {
        statementDate,
        dueDate,
        days,
        dueMonth,
        totalDue,
        paidAmount,
        eppBalance,
        balanceTransfer,
        pendingAmount,
        paymentStatus
      } = statementData;

      const fields = [];
      const values = [];

      if (statementDate !== undefined) { fields.push('statement_date = ?'); values.push(statementDate); }
      if (dueDate !== undefined) { fields.push('due_date = ?'); values.push(dueDate); }
      if (days !== undefined) { fields.push('days = ?'); values.push(days); }
      if (dueMonth !== undefined) { fields.push('due_month = ?'); values.push(dueMonth); }
      if (totalDue !== undefined) { fields.push('total_due = ?'); values.push(totalDue); }
      if (paidAmount !== undefined) { fields.push('paid_amount = ?'); values.push(paidAmount); }
      if (eppBalance !== undefined) { fields.push('epp_balance = ?'); values.push(eppBalance); }
      if (balanceTransfer !== undefined) { fields.push('balance_transfer = ?'); values.push(balanceTransfer); }
      if (pendingAmount !== undefined) { fields.push('pending_amount = ?'); values.push(pendingAmount); }
      if (paymentStatus !== undefined) { fields.push('payment_status = ?'); values.push(paymentStatus); }

      if (fields.length === 0) return await this.getById(id);

      fields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);

      const updateResult = await pool.query(
        `UPDATE card_statements SET ${fields.join(', ')} WHERE id = ?`,
        values
      );
      if (updateResult.affectedRows === 0) return null;

      const statement = await this.getById(id);
      if (!statement) return null;

      // Get card details
      const cardResult = await pool.query(
        'SELECT id, issuing_bank, card_holder, card_number, expiry_date, credit_limit, is_active FROM credit_cards_new WHERE id = ?',
        [statement.credit_card_id]
      );
      if (cardResult.rows.length > 0) {
        statement.card_id = cardResult.rows[0].id;
        statement.issuing_bank = cardResult.rows[0].issuing_bank;
        statement.card_holder = cardResult.rows[0].card_holder;
        statement.card_number = cardResult.rows[0].card_number;
        statement.expiry_date = cardResult.rows[0].expiry_date;
        statement.credit_limit = cardResult.rows[0].credit_limit;
        statement.is_active = cardResult.rows[0].is_active;
      }

      return statement;
    } catch (error) {
      throw error;
    }
  }

  // Update calculated fields (pending_amount and payment_status)
  static async updateCalculatedFields(id, pendingAmount, paymentStatus) {
    try {
      await pool.query(
        `UPDATE card_statements 
         SET pending_amount = ?, payment_status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [pendingAmount, paymentStatus, id]
      );
      const result = await pool.query(
        'SELECT id, pending_amount, payment_status FROM card_statements WHERE id = ?',
        [id]
      );
      return result.rows[0] || null;
    } catch (error) {
      throw error;
    }
  }

  // Check if statement exists for card and month
  static async exists(cardId, statementMonth) {
    try {
      const result = await pool.query(
        'SELECT id FROM card_statements WHERE credit_card_id = ? AND statement_month = ?',
        [cardId, statementMonth]
      );
      return result.rows.length > 0;
    } catch (error) {
      throw error;
    }
  }

  // Get statements by month
  static async getByMonth(statementMonth) {
    try {
      return await this.getAll({ month: statementMonth });
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Statement;
