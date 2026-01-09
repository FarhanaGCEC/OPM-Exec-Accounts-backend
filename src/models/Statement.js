const { pool } = require('../config/database');

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
          LEFT JOIN card_statements s ON c.id = s.credit_card_id AND s.statement_month = $1
          WHERE c.is_active = TRUE
        `;
        const params = [month];
        let paramCount = 1;

        if (cardId) {
          paramCount++;
          query += ` AND c.id = $${paramCount}`;
          params.push(cardId);
        }

        query += ` ORDER BY c.display_order ASC, COALESCE(s.statement_date, '1970-01-01'::date) ASC, c.issuing_bank ASC`;

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
        let paramCount = 0;

        if (month) {
          paramCount++;
          query += ` AND s.statement_month = $${paramCount}`;
          params.push(month);
        }

        if (cardId) {
          paramCount++;
          query += ` AND s.credit_card_id = $${paramCount}`;
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
        WHERE s.id = $1`,
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
        WHERE s.credit_card_id = $1 AND s.statement_month = $2`,
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

      const result = await pool.query(
        `INSERT INTO card_statements 
         (credit_card_id, statement_month, statement_date, due_date, days, due_month, total_due, paid_amount, 
          pending_amount, epp_balance, balance_transfer, payment_status) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
         RETURNING id, credit_card_id, statement_month, statement_date, due_date, days, due_month, total_due, 
                   paid_amount, pending_amount, epp_balance, balance_transfer, payment_status, 
                   created_at, updated_at`,
        [
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

      // Get card details
      const cardResult = await pool.query(
        'SELECT id, issuing_bank, card_holder, card_number, expiry_date, credit_limit, is_active FROM credit_cards_new WHERE id = $1',
        [creditCardId]
      );

      const statement = result.rows[0];
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
      if (error.code === '23505') {
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
      let paramCount = 0;

      if (statementDate !== undefined) {
        paramCount++;
        fields.push(`statement_date = $${paramCount}`);
        values.push(statementDate);
      }

      if (dueDate !== undefined) {
        paramCount++;
        fields.push(`due_date = $${paramCount}`);
        values.push(dueDate);
      }

      if (days !== undefined) {
        paramCount++;
        fields.push(`days = $${paramCount}`);
        values.push(days);
      }

      if (dueMonth !== undefined) {
        paramCount++;
        fields.push(`due_month = $${paramCount}`);
        values.push(dueMonth);
      }

      if (totalDue !== undefined) {
        paramCount++;
        fields.push(`total_due = $${paramCount}`);
        values.push(totalDue);
      }

      if (paidAmount !== undefined) {
        paramCount++;
        fields.push(`paid_amount = $${paramCount}`);
        values.push(paidAmount);
      }

      if (eppBalance !== undefined) {
        paramCount++;
        fields.push(`epp_balance = $${paramCount}`);
        values.push(eppBalance);
      }

      if (balanceTransfer !== undefined) {
        paramCount++;
        fields.push(`balance_transfer = $${paramCount}`);
        values.push(balanceTransfer);
      }

      if (pendingAmount !== undefined) {
        paramCount++;
        fields.push(`pending_amount = $${paramCount}`);
        values.push(pendingAmount);
      }

      if (paymentStatus !== undefined) {
        paramCount++;
        fields.push(`payment_status = $${paramCount}`);
        values.push(paymentStatus);
      }

      if (fields.length === 0) {
        return await this.getById(id);
      }

      paramCount++;
      fields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id);

      const query = `
        UPDATE card_statements 
        SET ${fields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING id, credit_card_id, statement_month, statement_date, due_date, days, due_month, total_due, 
                  paid_amount, pending_amount, epp_balance, balance_transfer, payment_status, 
                  created_at, updated_at
      `;

      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
        return null;
      }

      // Get card details
      const cardResult = await pool.query(
        'SELECT id, issuing_bank, card_holder, card_number, expiry_date, credit_limit, is_active FROM credit_cards_new WHERE id = $1',
        [result.rows[0].credit_card_id]
      );

      const statement = result.rows[0];
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
      const result = await pool.query(
        `UPDATE card_statements 
         SET pending_amount = $1, payment_status = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING id, pending_amount, payment_status`,
        [pendingAmount, paymentStatus, id]
      );

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Check if statement exists for card and month
  static async exists(cardId, statementMonth) {
    try {
      const result = await pool.query(
        'SELECT id FROM card_statements WHERE credit_card_id = $1 AND statement_month = $2',
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
