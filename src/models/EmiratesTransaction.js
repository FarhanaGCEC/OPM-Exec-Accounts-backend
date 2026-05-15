const { pool } = require('../config/database');

// Helper function to round to 2 decimal places
const roundToTwoDecimals = (value) => {
  return Math.round(parseFloat(value) * 100) / 100;
};

class EmiratesTransaction {
  // Get the latest balance (by date, then by id for same date) for a specific currency
  static async getLatestBalance(currency) {
    try {
      const result = await pool.query(
        'SELECT balance FROM emirates_transactions WHERE currency = ? ORDER BY date DESC, id DESC LIMIT 1',
        [currency]
      );
      return result.rows.length > 0 ? parseFloat(result.rows[0].balance) : 0;
    } catch (error) {
      throw error;
    }
  }

  // Get balance before a specific date (chronologically) for a specific currency
  static async getBalanceBeforeDate(date, currency) {
    try {
      const result = await pool.query(
        `SELECT balance FROM emirates_transactions 
         WHERE date < ? AND currency = ?
         ORDER BY date DESC, id DESC LIMIT 1`,
        [date, currency]
      );
      return result.rows.length > 0 ? parseFloat(result.rows[0].balance) : 0;
    } catch (error) {
      throw error;
    }
  }

  // Get all Emirates transactions (optionally filtered by currency)
  static async getAll(currency = null) {
    try {
      const normalizedCurrency =
        currency != null && String(currency).trim()
          ? String(currency).trim().toUpperCase()
          : null;

      const baseQuery = `
        SELECT 
          t.id,
          t.account_number,
          DATE_FORMAT(t.date, '%Y-%m-%d') AS date,
          t.description,
          t.details,
          t.currency,
          t.debit,
          t.bank_charges,
          t.credit,
          t.balance,
          t.created_by,
          u.username as created_by_username,
          t.created_at,
          t.updated_at
        FROM emirates_transactions t
        LEFT JOIN users u ON t.created_by = u.id
      `;
      const result = normalizedCurrency
        ? await pool.query(
            `${baseQuery} WHERE t.currency = ? ORDER BY t.date ASC, t.id ASC`,
            [normalizedCurrency]
          )
        : await pool.query(`${baseQuery} ORDER BY t.date ASC, t.id ASC`);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get a single Emirates transaction by ID
  static async getById(id) {
    try {
      const result = await pool.query(`
        SELECT 
          t.id,
          t.account_number,
          DATE_FORMAT(t.date, '%Y-%m-%d') AS date,
          t.description,
          t.details,
          t.currency,
          t.debit,
          t.bank_charges,
          t.credit,
          t.balance,
          t.created_by,
          u.username as created_by_username,
          t.created_at,
          t.updated_at
        FROM emirates_transactions t
        LEFT JOIN users u ON t.created_by = u.id
        WHERE t.id = ?
      `, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Create a new Emirates transaction and calculate balance
  static async create(transactionData) {
    try {
      const { 
        accountNumber, 
        date, 
        description, 
        details, 
        currency,
        debit, 
        bankCharges, 
        credit, 
        createdBy 
      } = transactionData;
      
      // Round amounts to 2 decimal places
      const roundedDebit = roundToTwoDecimals(debit || 0);
      const roundedBankCharges = roundToTwoDecimals(bankCharges || 0);
      const roundedCredit = roundToTwoDecimals(credit || 0);
      const transactionCurrency = currency || 'AED';

      // Get balance before this transaction's date (chronologically) for the same currency
      const balanceBeforeDate = await this.getBalanceBeforeDate(date, transactionCurrency);

      // If there are transactions on the same date with same currency, get the last one's balance
      const sameDateTransactions = await pool.query(
        `SELECT balance, debit, bank_charges, credit 
         FROM emirates_transactions 
         WHERE date = ? AND currency = ?
         ORDER BY id DESC`,
        [date, transactionCurrency]
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
        INSERT INTO emirates_transactions 
        (account_number, date, description, details, currency, debit, bank_charges, credit, balance, created_by) 
        VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
      `;
      const insertParams = [
        accountNumber || null,
        date,
        description,
        details || null,
        transactionCurrency,
        roundedDebit,
        roundedBankCharges,
        roundedCredit,
        newBalance,
        createdBy || null
      ];
      
      await pool.query(insertQuery, insertParams);
      const insertResult = await pool.query('SELECT id FROM emirates_transactions WHERE id = LAST_INSERT_ID()');
      const insertedId = insertResult.rows[0].id;

      // Recalculate all subsequent transactions (by date, then by id) for the same currency
      const subsequentTransactions = await pool.query(
        `SELECT id, debit, bank_charges, credit 
         FROM emirates_transactions 
         WHERE currency = ? AND (date > ? OR (date = ? AND id > ?))
         ORDER BY date ASC, id ASC`,
        [transactionCurrency, date, date, insertedId]
      );

      let currentBalance = newBalance;
      for (const txn of subsequentTransactions.rows) {
        currentBalance = currentBalance - parseFloat(txn.debit || 0) - parseFloat(txn.bank_charges || 0) + parseFloat(txn.credit || 0);
        currentBalance = roundToTwoDecimals(currentBalance);

        await pool.query(
          'UPDATE emirates_transactions SET balance = ? WHERE id = ?',
          [currentBalance, txn.id]
        );
      }

      // Get created_by username if created_by exists
      let createdByUsername = null;
      if (createdBy) {
        const userResult = await pool.query(
          'SELECT username FROM users WHERE id = ?',
          [createdBy]
        );
        if (userResult.rows.length > 0) {
          createdByUsername = userResult.rows[0].username;
        }
      }

      const fetchResult = await pool.query(
        `SELECT id, account_number, DATE_FORMAT(date, '%Y-%m-%d') AS date, description, details, currency, debit, bank_charges, credit, balance, created_by, created_at FROM emirates_transactions WHERE id = ?`,
        [insertedId]
      );
      const transaction = fetchResult.rows[0];
      return {
        ...transaction,
        created_by_username: createdByUsername
      };
    } catch (error) {
      throw error;
    }
  }

  // Update an Emirates transaction and recalculate balances
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
        currency,
        debit, 
        bankCharges, 
        credit 
      } = transactionData;

      // Round amounts to 2 decimal places
      const roundedDebit = roundToTwoDecimals(debit || 0);
      const roundedBankCharges = roundToTwoDecimals(bankCharges || 0);
      const roundedCredit = roundToTwoDecimals(credit || 0);

      // Get the currency of the transaction being updated
      const transactionCurrency = currency || oldTransaction.currency || 'AED';

      // Get balance before this transaction's date (chronologically, excluding current transaction) for the same currency
      const previousBalance = await pool.query(
        `SELECT balance FROM emirates_transactions 
         WHERE currency = ? AND (date < ? OR (date = ? AND id < ?))
         ORDER BY date DESC, id DESC LIMIT 1`,
        [transactionCurrency, date, date, id]
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
        `UPDATE emirates_transactions 
         SET account_number = ?, date = ?, description = ?, details = ?, currency = ?,
             debit = ?, bank_charges = ?, credit = ?, balance = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
        `,
        [
          accountNumber || null,
          date,
          description,
          details || null,
          transactionCurrency,
          roundedDebit,
          roundedBankCharges,
          roundedCredit,
          newBalance,
          id
        ]
      );

      if (result.affectedRows === 0) return null;

      // Recalculate all subsequent transactions (by date, then by id) for the same currency
      const subsequentTransactions = await pool.query(
        `SELECT id, debit, bank_charges, credit 
         FROM emirates_transactions 
         WHERE currency = ? AND (date > ? OR (date = ? AND id > ?))
         ORDER BY date ASC, id ASC`,
        [transactionCurrency, date, date, id]
      );

      let currentBalance = newBalance;
      for (const txn of subsequentTransactions.rows) {
        currentBalance = currentBalance - parseFloat(txn.debit || 0) - parseFloat(txn.bank_charges || 0) + parseFloat(txn.credit || 0);
        currentBalance = roundToTwoDecimals(currentBalance);

        await pool.query(
          'UPDATE emirates_transactions SET balance = ? WHERE id = ?',
          [currentBalance, txn.id]
        );
      }

      const transaction = await this.getById(id);
      if (!transaction) return null;
      let createdByUsername = null;
      if (transaction.created_by) {
        const userResult = await pool.query(
          'SELECT username FROM users WHERE id = ?',
          [transaction.created_by]
        );
        if (userResult.rows.length > 0) {
          createdByUsername = userResult.rows[0].username;
        }
      }

      return {
        ...transaction,
        created_by_username: createdByUsername
      };
    } catch (error) {
      throw error;
    }
  }

  // Delete an Emirates transaction and recalculate balances
  static async delete(id) {
    try {
      // Get the transaction to delete
      const transaction = await this.getById(id);
      if (!transaction) {
        return false;
      }

      const transactionDate = transaction.date;
      const transactionCurrency = transaction.currency || 'AED';
      const accountNumber = transaction.account_number;

      // Get balance before this transaction (chronologically) for the same currency
      const previousBalance = await pool.query(
        `SELECT balance FROM emirates_transactions 
         WHERE currency = ? AND (date < ? OR (date = ? AND id < ?))
         ORDER BY date DESC, id DESC LIMIT 1`,
        [transactionCurrency, transactionDate, transactionDate, id]
      );

      let balanceBefore = 0;
      if (previousBalance.rows.length > 0) {
        balanceBefore = parseFloat(previousBalance.rows[0].balance);
      }

      // Delete the transaction
      await pool.query('DELETE FROM emirates_transactions WHERE id = ?', [id]);

      // Recalculate all subsequent transactions (by date, then by id) for the same currency
      const subsequentTransactions = await pool.query(
        `SELECT id, debit, bank_charges, credit 
         FROM emirates_transactions 
         WHERE currency = ? AND (date > ? OR (date = ? AND id > ?))
         ORDER BY date ASC, id ASC`,
        [transactionCurrency, transactionDate, transactionDate, id]
      );

      let currentBalance = balanceBefore;
      for (const txn of subsequentTransactions.rows) {
        currentBalance = currentBalance - parseFloat(txn.debit || 0) - parseFloat(txn.bank_charges || 0) + parseFloat(txn.credit || 0);
        currentBalance = roundToTwoDecimals(currentBalance);

        await pool.query(
          'UPDATE emirates_transactions SET balance = ? WHERE id = ?',
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
      // Get all currencies
      const currenciesResult = await pool.query(`
        SELECT DISTINCT currency FROM emirates_transactions
      `);

      const finalBalances = {};

      for (const currencyRow of currenciesResult.rows) {
        const currency = currencyRow.currency;
        const result = await pool.query(`
          SELECT id, debit, bank_charges, credit 
          FROM emirates_transactions
          WHERE currency = ?
          ORDER BY date ASC, id ASC
        `, [currency]);

        let runningBalance = 0;
        const updates = [];

        for (const txn of result.rows) {
          runningBalance = runningBalance - parseFloat(txn.debit || 0) - parseFloat(txn.bank_charges || 0) + parseFloat(txn.credit || 0);
          runningBalance = roundToTwoDecimals(runningBalance);

          updates.push(
            pool.query('UPDATE emirates_transactions SET balance = ? WHERE id = ?', [
              runningBalance,
              txn.id
            ])
          );
        }

        await Promise.all(updates);
        finalBalances[currency] = roundToTwoDecimals(runningBalance);
      }

      return finalBalances;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = EmiratesTransaction;
