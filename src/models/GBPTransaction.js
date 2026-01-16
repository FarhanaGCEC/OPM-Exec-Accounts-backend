const { pool } = require('../config/database');

// Helper function to round to 2 decimal places
const roundToTwoDecimals = (value) => {
  return Math.round(parseFloat(value) * 100) / 100;
};

class GBPTransaction {
  // Get the latest balance (by date, then by id for same date)
  static async getLatestBalance() {
    try {
      const result = await pool.query(
        'SELECT balance FROM gbp_transactions ORDER BY date DESC, id DESC LIMIT 1'
      );
      return result.rows.length > 0 ? parseFloat(result.rows[0].balance) : 0;
    } catch (error) {
      throw error;
    }
  }

  // Get balance before a specific date (chronologically)
  static async getBalanceBeforeDate(date) {
    try {
      const result = await pool.query(
        `SELECT balance FROM gbp_transactions 
         WHERE date < $1
         ORDER BY date DESC, id DESC LIMIT 1`,
        [date]
      );
      return result.rows.length > 0 ? parseFloat(result.rows[0].balance) : 0;
    } catch (error) {
      throw error;
    }
  }

  // Get all USD transactions
  static async getAll() {
    try {
      const result = await pool.query(`
        SELECT 
          t.id,
          t.account_number,
          t.date,
          t.description,
          t.details,
          t.debit,
          t.bank_charges,
          t.credit,
          t.balance,
          t.created_by,
          u.username as created_by_username,
          t.created_at,
          t.updated_at
        FROM gbp_transactions t
        LEFT JOIN users u ON t.created_by = u.id
        ORDER BY t.date ASC, t.id ASC
      `);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get a single USD transaction by ID
  static async getById(id) {
    try {
      const result = await pool.query(`
        SELECT 
          t.id,
          t.account_number,
          t.date,
          t.description,
          t.details,
          t.debit,
          t.bank_charges,
          t.credit,
          t.balance,
          t.created_by,
          u.username as created_by_username,
          t.created_at,
          t.updated_at
        FROM gbp_transactions t
        LEFT JOIN users u ON t.created_by = u.id
        WHERE t.id = $1
      `, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Create a new USD transaction and calculate balance
  static async create(transactionData) {
    try {
      const { 
        accountNumber, 
        date, 
        description, 
        details, 
        debit, 
        bankCharges, 
        credit, 
        createdBy 
      } = transactionData;
      
      // Round amounts to 2 decimal places
      const roundedDebit = roundToTwoDecimals(debit || 0);
      const roundedBankCharges = roundToTwoDecimals(bankCharges || 0);
      const roundedCredit = roundToTwoDecimals(credit || 0);

      // Get balance before this transaction's date (chronologically)
      const balanceBeforeDate = await this.getBalanceBeforeDate(date);

      // If there are transactions on the same date, get the last one's balance
      const sameDateTransactions = await pool.query(
        `SELECT balance, debit, bank_charges, credit 
         FROM gbp_transactions 
         WHERE date = $1
         ORDER BY id DESC`,
        [date]
      );

      // Calculate running balance for same-date transactions
      let runningBalance = balanceBeforeDate;
      for (const txn of sameDateTransactions.rows) {
        runningBalance = runningBalance - parseFloat(txn.debit || 0) - parseFloat(txn.bank_charges || 0) + parseFloat(txn.credit || 0);
        runningBalance = roundToTwoDecimals(runningBalance);
      }

      // Now calculate balance for the new transaction
      let newBalance = runningBalance - roundedDebit - roundedBankCharges + roundedCredit;
      newBalance = roundToTwoDecimals(newBalance);

      // Insert transaction
      let insertQuery = `
        INSERT INTO gbp_transactions 
        (account_number, date, description, details, debit, bank_charges, credit, balance, created_by) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
        RETURNING id, account_number, date, description, details, debit, bank_charges, credit, balance, created_by, created_at
      `;
      const insertParams = [
        accountNumber || null,
        date,
        description,
        details || null,
        roundedDebit,
        roundedBankCharges,
        roundedCredit,
        newBalance,
        createdBy || null
      ];
      
      const result = await pool.query(insertQuery, insertParams);

      // Recalculate all subsequent transactions (by date, then by id)
      const insertedId = result.rows[0].id;
      const subsequentTransactions = await pool.query(
        `SELECT id, debit, bank_charges, credit 
         FROM gbp_transactions 
         WHERE date > $1 OR (date = $1 AND id > $2)
         ORDER BY date ASC, id ASC`,
        [date, insertedId]
      );

      let currentBalance = newBalance;
      for (const txn of subsequentTransactions.rows) {
        currentBalance = currentBalance - parseFloat(txn.debit || 0) - parseFloat(txn.bank_charges || 0) + parseFloat(txn.credit || 0);
        currentBalance = roundToTwoDecimals(currentBalance);

        await pool.query(
          'UPDATE gbp_transactions SET balance = $1 WHERE id = $2',
          [currentBalance, txn.id]
        );
      }

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

      const transaction = result.rows[0];
      return {
        ...transaction,
        created_by_username: createdByUsername
      };
    } catch (error) {
      throw error;
    }
  }

  // Update a USD transaction and recalculate balances
  static async update(id, transactionData) {
    try {
      // Get the old transaction
      const oldTransaction = await this.getById(id);
      if (!oldTransaction) {
        return null;
      }

      const { 
        accountNumber, 
        date, 
        description, 
        details, 
        debit, 
        bankCharges, 
        credit 
      } = transactionData;

      // Round amounts to 2 decimal places
      const roundedDebit = roundToTwoDecimals(debit || 0);
      const roundedBankCharges = roundToTwoDecimals(bankCharges || 0);
      const roundedCredit = roundToTwoDecimals(credit || 0);

      // Get balance before this transaction's date (chronologically, excluding current transaction)
      const previousBalance = await pool.query(
        `SELECT balance FROM gbp_transactions 
         WHERE (date < $1 OR (date = $1 AND id < $2))
         ORDER BY date DESC, id DESC LIMIT 1`,
        [date, id]
      );

      let balanceBefore = 0;
      if (previousBalance.rows.length > 0) {
        balanceBefore = parseFloat(previousBalance.rows[0].balance);
      }

      // Calculate new balance based on updated transaction
      let newBalance = balanceBefore - roundedDebit - roundedBankCharges + roundedCredit;
      newBalance = roundToTwoDecimals(newBalance);

      // Update the transaction
      const result = await pool.query(
        `UPDATE gbp_transactions 
         SET account_number = $1, date = $2, description = $3, details = $4, 
             debit = $5, bank_charges = $6, credit = $7, balance = $8, updated_at = CURRENT_TIMESTAMP
         WHERE id = $9
         RETURNING id, account_number, date, description, details, debit, bank_charges, credit, balance, created_by, created_at, updated_at`,
        [
          accountNumber || null,
          date,
          description,
          details || null,
          roundedDebit,
          roundedBankCharges,
          roundedCredit,
          newBalance,
          id
        ]
      );

      if (result.rows.length === 0) {
        return null;
      }

      // Recalculate all subsequent transactions (by date, then by id)
      const subsequentTransactions = await pool.query(
        `SELECT id, debit, bank_charges, credit 
         FROM gbp_transactions 
         WHERE date > $1 OR (date = $1 AND id > $2)
         ORDER BY date ASC, id ASC`,
        [date, id]
      );

      let currentBalance = newBalance;
      for (const txn of subsequentTransactions.rows) {
        currentBalance = currentBalance - parseFloat(txn.debit || 0) - parseFloat(txn.bank_charges || 0) + parseFloat(txn.credit || 0);
        currentBalance = roundToTwoDecimals(currentBalance);

        await pool.query(
          'UPDATE gbp_transactions SET balance = $1 WHERE id = $2',
          [currentBalance, txn.id]
        );
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

      const transaction = result.rows[0];
      return {
        ...transaction,
        created_by_username: createdByUsername
      };
    } catch (error) {
      throw error;
    }
  }

  // Delete a USD transaction and recalculate balances
  static async delete(id) {
    try {
      // Get the transaction to delete
      const transaction = await this.getById(id);
      if (!transaction) {
        return false;
      }

      const transactionDate = transaction.date;
      const accountNumber = transaction.account_number;

      // Get balance before this transaction (chronologically)
      const previousBalance = await pool.query(
        `SELECT balance FROM gbp_transactions 
         WHERE (date < $1 OR (date = $1 AND id < $2))
         ORDER BY date DESC, id DESC LIMIT 1`,
        [transactionDate, id]
      );

      let balanceBefore = 0;
      if (previousBalance.rows.length > 0) {
        balanceBefore = parseFloat(previousBalance.rows[0].balance);
      }

      // Delete the transaction
      await pool.query('DELETE FROM gbp_transactions WHERE id = $1', [id]);

      // Recalculate all subsequent transactions (by date, then by id)
      const subsequentTransactions = await pool.query(
        `SELECT id, debit, bank_charges, credit 
         FROM gbp_transactions 
         WHERE date > $1 OR (date = $1 AND id > $2)
         ORDER BY date ASC, id ASC`,
        [transactionDate, id]
      );

      let currentBalance = balanceBefore;
      for (const txn of subsequentTransactions.rows) {
        currentBalance = currentBalance - parseFloat(txn.debit || 0) - parseFloat(txn.bank_charges || 0) + parseFloat(txn.credit || 0);
        currentBalance = roundToTwoDecimals(currentBalance);

        await pool.query(
          'UPDATE gbp_transactions SET balance = $1 WHERE id = $2',
          [currentBalance, txn.id]
        );
      }

      return true;
    } catch (error) {
      throw error;
    }
  }

  // Recalculate all balances (useful for fixing incorrect balances)
  static async recalculateAllBalances() {
    try {
      const result = await pool.query(`
        SELECT id, debit, bank_charges, credit 
        FROM gbp_transactions
        ORDER BY date ASC, id ASC
      `);

      let runningBalance = 0;
      const updates = [];

      for (const txn of result.rows) {
        runningBalance = runningBalance - parseFloat(txn.debit || 0) - parseFloat(txn.bank_charges || 0) + parseFloat(txn.credit || 0);
        runningBalance = roundToTwoDecimals(runningBalance);

        updates.push(
          pool.query('UPDATE gbp_transactions SET balance = $1 WHERE id = $2', [
            runningBalance,
            txn.id
          ])
        );
      }

      await Promise.all(updates);
      return roundToTwoDecimals(runningBalance);
    } catch (error) {
      throw error;
    }
  }
}

module.exports = GBPTransaction;
