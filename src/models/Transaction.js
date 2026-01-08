const { pool } = require('../config/database');

// Helper function to round to 2 decimal places
const roundToTwoDecimals = (value) => {
  return Math.round(parseFloat(value) * 100) / 100;
};

class Transaction {
  // Get the latest balance (by date, then by id for same date)
  static async getLatestBalance() {
    try {
      const result = await pool.query(
        'SELECT balance FROM transactions ORDER BY date DESC, id DESC LIMIT 1'
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
        `SELECT balance FROM transactions 
         WHERE date < $1
         ORDER BY date DESC, id DESC LIMIT 1`,
        [date]
      );
      return result.rows.length > 0 ? parseFloat(result.rows[0].balance) : 0;
    } catch (error) {
      throw error;
    }
  }

  // Recalculate all balances chronologically (by date, then by id)
  static async recalculateAllBalances() {
    try {
      // Get all transactions ordered by date ASC, then id ASC
      const result = await pool.query(
        'SELECT id, type, amount FROM transactions ORDER BY date ASC, id ASC'
      );

      let runningBalance = 0;
      const updates = [];

      for (const txn of result.rows) {
        if (txn.type === 'Debit') {
          runningBalance = runningBalance - parseFloat(txn.amount);
        } else if (txn.type === 'Credit') {
          runningBalance = runningBalance + parseFloat(txn.amount);
        }

        // Round balance to 2 decimal places
        runningBalance = roundToTwoDecimals(runningBalance);

        updates.push(
          pool.query('UPDATE transactions SET balance = $1 WHERE id = $2', [
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

  // Get all transactions with category name (for table display)
  static async getAll() {
    try {
      const result = await pool.query(`
        SELECT 
          t.id,
          t.date,
          t.type,
          t.category_id,
          t.category_type,
          COALESCE(pc.name, rc.name) as category_name,
          t.payment_type,
          t.cheque_number,
          t.amount,
          t.balance,
          t.remarks,
          t.created_by,
          u.username as created_by_username,
          t.created_at
        FROM transactions t
        LEFT JOIN payables_categories pc ON t.category_id = pc.id AND t.category_type = 'payable'
        LEFT JOIN receivables_categories rc ON t.category_id = rc.id AND t.category_type = 'receivable'
        LEFT JOIN users u ON t.created_by = u.id
        ORDER BY t.date ASC, t.id ASC
      `);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get a single transaction by ID
  static async getById(id) {
    try {
      const result = await pool.query(`
        SELECT 
          t.id,
          t.date,
          t.type,
          t.category_id,
          t.category_type,
          COALESCE(pc.name, rc.name) as category_name,
          t.payment_type,
          t.cheque_number,
          t.amount,
          t.balance,
          t.remarks,
          t.created_by,
          u.username as created_by_username,
          t.created_at
        FROM transactions t
        LEFT JOIN payables_categories pc ON t.category_id = pc.id AND t.category_type = 'payable'
        LEFT JOIN receivables_categories rc ON t.category_id = rc.id AND t.category_type = 'receivable'
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

  // Create a new transaction and calculate balance
  static async create(transactionData) {
    try {
      const { date, type, categoryId, paymentType, chequeNumber, amount, remarks, createdBy } = transactionData;
      
      // Round amount to 2 decimal places
      const roundedAmount = roundToTwoDecimals(amount);

      // Determine category type based on transaction type
      let categoryType = null;
      if (categoryId) {
        if (type === 'Debit') {
          categoryType = 'payable';
        } else if (type === 'Credit') {
          categoryType = 'receivable';
        }
      }

      // Validate category exists in the correct table
      if (categoryId && categoryType) {
        const tableName = categoryType === 'payable' ? 'payables_categories' : 'receivables_categories';
        const categoryResult = await pool.query(
          `SELECT id FROM ${tableName} WHERE id = $1`,
          [categoryId]
        );
        if (categoryResult.rows.length === 0) {
          throw new Error(`Category ID ${categoryId} not found in ${categoryType} categories`);
        }
      }

      // Get balance before this transaction's date (chronologically)
      // First, get balance from transactions before this date
      const balanceBeforeDate = await pool.query(
        `SELECT balance FROM transactions 
         WHERE date < $1
         ORDER BY date DESC, id DESC LIMIT 1`,
        [date]
      );

      let previousBalance = 0;
      if (balanceBeforeDate.rows.length > 0) {
        previousBalance = parseFloat(balanceBeforeDate.rows[0].balance);
      }

      // If there are transactions on the same date, get the last one's balance
      const sameDateTransactions = await pool.query(
        `SELECT balance, type, amount FROM transactions 
         WHERE date = $1
         ORDER BY id DESC`,
        [date]
      );

      // Calculate running balance for same-date transactions
      let runningBalance = previousBalance;
      for (const txn of sameDateTransactions.rows) {
        if (txn.type === 'Debit') {
          runningBalance = runningBalance - parseFloat(txn.amount);
        } else {
          runningBalance = runningBalance + parseFloat(txn.amount);
        }
        // Round balance to 2 decimal places
        runningBalance = roundToTwoDecimals(runningBalance);
      }

      // Now calculate balance for the new transaction
      let newBalance;
      if (type === 'Debit') {
        newBalance = runningBalance - roundedAmount;
      } else if (type === 'Credit') {
        newBalance = runningBalance + roundedAmount;
      } else {
        throw new Error('Invalid transaction type. Must be "Debit" or "Credit"');
      }
      // Round balance to 2 decimal places
      newBalance = roundToTwoDecimals(newBalance);

      // Insert transaction
      const result = await pool.query(
        `INSERT INTO transactions 
         (date, type, category_id, category_type, payment_type, cheque_number, amount, balance, remarks, created_by) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
         RETURNING id, date, type, category_id, category_type, payment_type, cheque_number, amount, balance, remarks, created_by, created_at`,
        [
          date,
          type,
          categoryId || null,
          categoryType,
          paymentType,
          chequeNumber || null,
          roundedAmount,
          newBalance,
          remarks || null,
          createdBy || null
        ]
      );

      // Recalculate all subsequent transactions (by date, then by id)
      const insertedId = result.rows[0].id;
      const subsequentTransactions = await pool.query(
        `SELECT id, type, amount FROM transactions 
         WHERE date > $1 OR (date = $1 AND id > $2)
         ORDER BY date ASC, id ASC`,
        [date, insertedId]
      );

      let currentBalance = newBalance;
      for (const txn of subsequentTransactions.rows) {
        if (txn.type === 'Debit') {
          currentBalance = currentBalance - parseFloat(txn.amount);
        } else {
          currentBalance = currentBalance + parseFloat(txn.amount);
        }

        await pool.query(
          'UPDATE transactions SET balance = $1 WHERE id = $2',
          [currentBalance, txn.id]
        );
      }

      // Get category name if category_id exists
      let categoryName = null;
      if (categoryId && categoryType) {
        const tableName = categoryType === 'payable' ? 'payables_categories' : 'receivables_categories';
        const categoryResult = await pool.query(
          `SELECT name FROM ${tableName} WHERE id = $1`,
          [categoryId]
        );
        if (categoryResult.rows.length > 0) {
          categoryName = categoryResult.rows[0].name;
        }
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
        category_name: categoryName,
        created_by_username: createdByUsername
      };
    } catch (error) {
      throw error;
    }
  }

  // Update a transaction and recalculate balances
  static async update(id, transactionData) {
    try {
      // Get the old transaction
      const oldTransaction = await this.getById(id);
      if (!oldTransaction) {
        return null;
      }

      const { date, type, categoryId, paymentType, chequeNumber, amount, remarks } = transactionData;

      // Round amount to 2 decimal places
      const roundedAmount = roundToTwoDecimals(amount);

      // Determine category type based on transaction type
      let categoryType = null;
      if (categoryId) {
        if (type === 'Debit') {
          categoryType = 'payable';
        } else if (type === 'Credit') {
          categoryType = 'receivable';
        }
      }

      // Validate category exists in the correct table
      if (categoryId && categoryType) {
        const tableName = categoryType === 'payable' ? 'payables_categories' : 'receivables_categories';
        const categoryResult = await pool.query(
          `SELECT id FROM ${tableName} WHERE id = $1`,
          [categoryId]
        );
        if (categoryResult.rows.length === 0) {
          throw new Error(`Category ID ${categoryId} not found in ${categoryType} categories`);
        }
      }

      // Get balance before this transaction's date (chronologically, excluding current transaction)
      const previousBalance = await pool.query(
        `SELECT balance FROM transactions 
         WHERE (date < $1 OR (date = $1 AND id < $2))
         ORDER BY date DESC, id DESC LIMIT 1`,
        [date, id]
      );

      let balanceBefore = 0;
      if (previousBalance.rows.length > 0) {
        balanceBefore = parseFloat(previousBalance.rows[0].balance);
      }

      // Calculate new balance based on updated transaction
      let newBalance;
      if (type === 'Debit') {
        newBalance = balanceBefore - roundedAmount;
      } else if (type === 'Credit') {
        newBalance = balanceBefore + roundedAmount;
      } else {
        throw new Error('Invalid transaction type. Must be "Debit" or "Credit"');
      }
      // Round balance to 2 decimal places
      newBalance = roundToTwoDecimals(newBalance);

      // Update the transaction
      const result = await pool.query(
        `UPDATE transactions 
         SET date = $1, type = $2, category_id = $3, category_type = $4, payment_type = $5, 
             cheque_number = $6, amount = $7, balance = $8, remarks = $9
         WHERE id = $10
         RETURNING id, date, type, category_id, category_type, payment_type, cheque_number, amount, balance, remarks, created_by, created_at`,
        [
          date,
          type,
          categoryId || null,
          categoryType,
          paymentType,
          chequeNumber || null,
          roundedAmount,
          newBalance,
          remarks || null,
          id
        ]
      );

      if (result.rows.length === 0) {
        return null;
      }

      // Recalculate all subsequent transactions (by date, then by id)
      const subsequentTransactions = await pool.query(
        `SELECT id, type, amount FROM transactions 
         WHERE date > $1 OR (date = $1 AND id > $2)
         ORDER BY date ASC, id ASC`,
        [date, id]
      );

      let currentBalance = newBalance;
      for (const txn of subsequentTransactions.rows) {
        if (txn.type === 'Debit') {
          currentBalance = currentBalance - parseFloat(txn.amount);
        } else {
          currentBalance = currentBalance + parseFloat(txn.amount);
        }
        // Round balance to 2 decimal places
        currentBalance = roundToTwoDecimals(currentBalance);

        await pool.query(
          'UPDATE transactions SET balance = $1 WHERE id = $2',
          [currentBalance, txn.id]
        );
      }

      // Get category name if category_id exists
      let categoryName = null;
      if (categoryId && categoryType) {
        const tableName = categoryType === 'payable' ? 'payables_categories' : 'receivables_categories';
        const categoryResult = await pool.query(
          `SELECT name FROM ${tableName} WHERE id = $1`,
          [categoryId]
        );
        if (categoryResult.rows.length > 0) {
          categoryName = categoryResult.rows[0].name;
        }
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
        category_name: categoryName,
        created_by_username: createdByUsername
      };
    } catch (error) {
      throw error;
    }
  }

  // Delete a transaction and recalculate balances
  static async delete(id) {
    try {
      // Get the transaction to delete
      const transaction = await this.getById(id);
      if (!transaction) {
        return false;
      }

      const transactionDate = transaction.date;

      // Get balance before this transaction (chronologically)
      const previousBalance = await pool.query(
        `SELECT balance FROM transactions 
         WHERE (date < $1 OR (date = $1 AND id < $2))
         ORDER BY date DESC, id DESC LIMIT 1`,
        [transactionDate, id]
      );

      let balanceBefore = 0;
      if (previousBalance.rows.length > 0) {
        balanceBefore = parseFloat(previousBalance.rows[0].balance);
      }

      // Delete the transaction
      await pool.query('DELETE FROM transactions WHERE id = $1', [id]);

      // Recalculate all subsequent transactions (by date, then by id)
      const subsequentTransactions = await pool.query(
        `SELECT id, type, amount FROM transactions 
         WHERE date > $1 OR (date = $1 AND id > $2)
         ORDER BY date ASC, id ASC`,
        [transactionDate, id]
      );

      let currentBalance = balanceBefore;
      for (const txn of subsequentTransactions.rows) {
        if (txn.type === 'Debit') {
          currentBalance = currentBalance - parseFloat(txn.amount);
        } else {
          currentBalance = currentBalance + parseFloat(txn.amount);
        }
        // Round balance to 2 decimal places
        currentBalance = roundToTwoDecimals(currentBalance);

        await pool.query(
          'UPDATE transactions SET balance = $1 WHERE id = $2',
          [currentBalance, txn.id]
        );
      }

      return true;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Transaction;

