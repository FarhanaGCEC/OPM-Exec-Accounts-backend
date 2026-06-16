const Statement = require('../models/Statement');
const Card = require('../models/Card');
const { pool } = require('../config/database');
const { randomUUID } = require('crypto');
const { calculateStatementBalances } = require('../utils/statementAmounts');

class StatementService {
  /**
   * Calculate pending amount
   * pending_amount = total_due - (paid_amount + epp_balance)
   */
  static calculatePendingAmount(totalDue, paidAmount, eppBalance = 0) {
    return calculateStatementBalances(totalDue, paidAmount, eppBalance).amount_pending;
  }

  /**
   * Calculate payment status based on business rules
   * - PAID → pending_amount = 0
   * - PARTIAL → pending_amount > 0 AND due_date >= today
   * - OVERDUE → pending_amount > 0 AND due_date < today
   */
  static calculatePaymentStatus(pendingAmount, dueDate) {
    const pending = parseFloat(pendingAmount) || 0;
    
    if (pending === 0) {
      return 'PAID';
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const due = new Date(dueDate);
    due.setHours(0, 0, 0, 0);

    if (due < today) {
      return 'OVERDUE';
    }

    return 'PARTIAL';
  }

  /**
   * Initialize statements for a month
   * Auto-creates statements for all active credit cards for that month (if not exists)
   * Uses transaction to ensure atomicity
   * @param {string} statementMonth - Month in YYYY-MM format
   * @param {Object} statementDatesMap - Optional mapping of card_id to statement_date (YYYY-MM-DD)
   */
  static async initializeStatementsForMonth(statementMonth, statementDatesMap = {}) {
    // Validate month format (YYYY-MM)
    const monthRegex = /^\d{4}-\d{2}$/;
    if (!monthRegex.test(statementMonth)) {
      throw new Error('Invalid statement_month format. Expected YYYY-MM');
    }

    // Validate month is a valid date
    const [year, month] = statementMonth.split('-');
    const monthNum = parseInt(month);
    const yearNum = parseInt(year);
    
    if (monthNum < 1 || monthNum > 12) {
      throw new Error('Invalid month. Must be between 01 and 12');
    }

    if (yearNum < 2000 || yearNum > 2100) {
      throw new Error('Invalid year. Must be between 2000 and 2100');
    }

    const client = await pool.connect();

    try {
      await client.beginTransaction();

      // Get all active cards
      const activeCards = await Card.getActiveCards();

      if (activeCards.length === 0) {
        await client.rollback();
        throw new Error('No active credit cards found');
      }

      const createdStatements = [];
      const skippedStatements = [];

      // Calculate default dates for the month
      // We'll calculate statement_date per card using each card's statement_day
      
      // Default due_month: Format as "Month YYYY" (e.g., "February 2024")
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                         'July', 'August', 'September', 'October', 'November', 'December'];
      const dueMonthStr = `${monthNames[monthNum - 1]} ${yearNum}`;

      // Build a lookup map: card_id -> statement_date AND card_number -> statement_date
      const statementDateByCardId = {};
      const statementDateByCardNumber = {};
      
      if (statementDatesMap) {
        for (const [key, date] of Object.entries(statementDatesMap)) {
          // Check if key is a UUID (card_id) or card number
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
            statementDateByCardId[key] = date;
          } else {
            // Assume it's a card number (with or without spaces)
            const normalizedCardNumber = key.replace(/\s/g, '');
            statementDateByCardNumber[normalizedCardNumber] = date;
          }
        }
      }

      for (const card of activeCards) {
        // Check if statement already exists
        const exists = await Statement.exists(card.id, statementMonth);

        if (exists) {
          skippedStatements.push({
            card_id: card.id,
            issuing_bank: card.issuing_bank,
            statement_month: statementMonth,
            reason: 'Statement already exists'
          });
          continue;
        }

        // Get card's billing_cycle_days and statement_day
        const cardDetails = await client.query(
          'SELECT billing_cycle_days, statement_day FROM credit_cards_new WHERE id = ?',
          [card.id]
        );
        const billingCycleDays = cardDetails.rows[0]?.billing_cycle_days || 25;
        const statementDay = cardDetails.rows[0]?.statement_day || 1;

        // Calculate default statement_date using card's statement_day for the selected month
        // Handle cases where statement_day might exceed days in month (use last day of month)
        const daysInMonth = new Date(yearNum, monthNum, 0).getDate();
        const finalStatementDay = Math.min(statementDay, daysInMonth);
        const defaultStatementDate = new Date(yearNum, monthNum - 1, finalStatementDay).toISOString().split('T')[0];

        // Use custom statement_date if provided, otherwise use card's statement_day
        // Priority: custom date (by card_id or card_number) > card's statement_day
        let finalStatementDate = defaultStatementDate;
        
        // Check by card_id first
        if (statementDateByCardId[card.id]) {
          finalStatementDate = statementDateByCardId[card.id];
        } 
        // Check by card_number (normalize both for comparison)
        else if (card.card_number) {
          const normalizedCardNumber = card.card_number.replace(/\s/g, '');
          if (statementDateByCardNumber[normalizedCardNumber]) {
            finalStatementDate = statementDateByCardNumber[normalizedCardNumber];
          }
        }
        
        // Validate the date format if it was custom
        if (finalStatementDate !== defaultStatementDate) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(finalStatementDate)) {
            throw new Error(`Invalid statement_date format for card ${card.issuing_bank}. Expected YYYY-MM-DD`);
          }
          // Verify the custom date is within the statement month
          const customDateMonth = finalStatementDate.substring(0, 7); // Get YYYY-MM part
          if (customDateMonth !== statementMonth) {
            throw new Error(`Statement date ${finalStatementDate} must be within month ${statementMonth}`);
          }
        }

        // Calculate due_date = statement_date + billing_cycle_days
        const stmtDate = new Date(finalStatementDate);
        const dueDate = new Date(stmtDate);
        dueDate.setDate(dueDate.getDate() + billingCycleDays);
        const dueDateStr = dueDate.toISOString().split('T')[0];

        // Create new statement with default values
        const statementData = {
          creditCardId: card.id,
          statementMonth: statementMonth,
          statementDate: finalStatementDate,
          dueDate: dueDateStr,
          days: billingCycleDays,
          dueMonth: dueMonthStr,
          totalDue: 0,
          paidAmount: 0,
          pendingAmount: 0,
          eppBalance: 0,
          balanceTransfer: 0,
          minPaymentDue: 0,
          paymentStatus: 'PARTIAL'
        };

        // Insert statement (generate UUID for MySQL compatibility)
        const statementId = randomUUID();
        await client.query(
          `INSERT INTO card_statements 
           (id, credit_card_id, statement_month, statement_date, due_date, days, due_month, total_due, paid_amount, 
            pending_amount, epp_balance, balance_transfer, min_payment_due, payment_status) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            statementId,
            statementData.creditCardId,
            statementData.statementMonth,
            statementData.statementDate,
            statementData.dueDate,
            statementData.days,
            statementData.dueMonth,
            statementData.totalDue,
            statementData.paidAmount,
            statementData.pendingAmount,
            statementData.eppBalance,
            statementData.balanceTransfer,
            statementData.minPaymentDue,
            statementData.paymentStatus
          ]
        );

        createdStatements.push({
          id: statementId,
          credit_card_id: statementData.creditCardId,
          statement_month: statementData.statementMonth,
          issuing_bank: card.issuing_bank,
          card_holder: card.card_holder
        });
      }

      await client.commit();

      return {
        created: createdStatements,
        skipped: skippedStatements,
        totalCreated: createdStatements.length,
        totalSkipped: skippedStatements.length
      };
    } catch (error) {
      await client.rollback();
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update statement and recalculate pending_amount and payment_status
   */
  static async updateStatement(statementId, updateData) {
    // Get existing statement
    const existing = await Statement.getById(statementId);
    if (!existing) {
      throw new Error('Statement not found');
    }

    // Merge existing values with update data
    const totalDue = updateData.total_due !== undefined 
     ? parseFloat(updateData.total_due) 
      : parseFloat(existing.total_due);
    
    const paidAmount = updateData.paid_amount !== undefined 
     ? parseFloat(updateData.paid_amount) 
      : parseFloat(existing.paid_amount);

    const eppBalance = updateData.epp_balance !== undefined 
     ? parseFloat(updateData.epp_balance) 
      : parseFloat(existing.epp_balance || 0);

    // paid_amount and epp_balance must be >= 0; total_due may be negative (overpayment credit)
    if (paidAmount < 0 || eppBalance < 0) {
      throw new Error('paid_amount and epp_balance must be >= 0');
    }

    if (updateData.balance_transfer !== undefined && parseFloat(updateData.balance_transfer) < 0) {
      throw new Error('balance_transfer must be >= 0');
    }

    if (updateData.min_payment_due !== undefined && parseFloat(updateData.min_payment_due) < 0) {
      throw new Error('min_payment_due must be >= 0');
    }

    // Handle statement_date update: auto-calculate due_date if statement_date changes
    let finalStatementDate = updateData.statement_date || existing.statement_date;
    let finalDueDate = updateData.due_date;
    let finalDays = existing.days;

    // If statement_date is being updated, auto-calculate due_date from card's billing_cycle_days
    if (updateData.statement_date && updateData.statement_date !== existing.statement_date) {
      // Get card's billing_cycle_days
      const Card = require('../models/Card');
      const card = await Card.getById(existing.credit_card_id);
      if (!card) {
        throw new Error('Credit card not found');
      }
      const billingCycleDays = card.billing_cycle_days || 25;
      
      // Calculate due_date = statement_date + billing_cycle_days
      const stmtDate = new Date(updateData.statement_date);
      const calculatedDueDate = new Date(stmtDate);
      calculatedDueDate.setDate(calculatedDueDate.getDate() + billingCycleDays);
      finalDueDate = calculatedDueDate.toISOString().split('T')[0];
      finalDays = billingCycleDays;
    } else if (!finalDueDate) {
      finalDueDate = existing.due_date;
    }

    // Recalculate pending_amount from total_due, paid_amount and epp_balance
    // Overpayment is allowed and reflected as credit_balance at response level.
    const balances = calculateStatementBalances(totalDue, paidAmount, eppBalance);
    const pendingAmount = balances.amount_pending;

    // Recalculate payment_status based on pending_amount and due_date
    const paymentStatus = this.calculatePaymentStatus(pendingAmount, finalDueDate);

    // Update statement fields (including calculated fields: pending_amount and payment_status)
    const updated = await Statement.update(statementId, {
      statementDate: finalStatementDate,
      dueDate: finalDueDate,
      days: finalDays,
      dueMonth: updateData.due_month !== undefined ? updateData.due_month : existing.due_month,
      totalDue: totalDue,
      paidAmount: paidAmount,
      eppBalance: eppBalance,
      balanceTransfer: updateData.balance_transfer !== undefined ? parseFloat(updateData.balance_transfer) : parseFloat(existing.balance_transfer || 0),
      minPaymentDue: updateData.min_payment_due !== undefined ? parseFloat(updateData.min_payment_due) : undefined,
      pendingAmount: pendingAmount,
      paymentStatus: paymentStatus
    });

    // Fetch updated statement with card details
    const finalStatement = await Statement.getById(statementId);

    return finalStatement;
  }
}

module.exports = StatementService;
