const { pool } = require('../config/database');

class Transaction {
  // Get the latest balance
  static async getLatestBalance() {
    try {
      const result = await pool.query(
        'SELECT balance FROM transactions ORDER BY id DESC LIMIT 1'
      );
      return result.rows.length > 0 ? parseFloat(result.rows[0].balance) : 0;
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
          pc.name as category_name,
          t.payment_type,
          t.cheque_number,
          t.amount,
          t.balance,
          t.created_by,
          u.username as created_by_username,
          t.created_at
        FROM transactions t
        LEFT JOIN payables_categories pc ON t.category_id = pc.id
        LEFT JOIN users u ON t.created_by = u.id
        ORDER BY t.date DESC, t.id DESC
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
          pc.name as category_name,
          t.payment_type,
          t.cheque_number,
          t.amount,
          t.balance,
          t.created_by,
          u.username as created_by_username,
          t.created_at
        FROM transactions t
        LEFT JOIN payables_categories pc ON t.category_id = pc.id
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
      const { date, type, categoryId, paymentType, chequeNumber, amount, createdBy } = transactionData;

      // Get the latest balance
      const previousBalance = await this.getLatestBalance();

      // Calculate new balance
      let newBalance;
      if (type === 'Debit') {
        newBalance = previousBalance - parseFloat(amount);
      } else if (type === 'Credit') {
        newBalance = previousBalance + parseFloat(amount);
      } else {
        throw new Error('Invalid transaction type. Must be "Debit" or "Credit"');
      }

      // Insert transaction
      const result = await pool.query(
        `INSERT INTO transactions 
         (date, type, category_id, payment_type, cheque_number, amount, balance, created_by) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
         RETURNING id, date, type, category_id, payment_type, cheque_number, amount, balance, created_by, created_at`,
        [
          date,
          type,
          categoryId || null,
          paymentType,
          chequeNumber || null,
          amount,
          newBalance,
          createdBy || null
        ]
      );

      // Get category name if category_id exists
      let categoryName = null;
      if (categoryId) {
        const categoryResult = await pool.query(
          'SELECT name FROM payables_categories WHERE id = $1',
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

      const { date, type, categoryId, paymentType, chequeNumber, amount } = transactionData;

      // Get the transaction before this one to recalculate from there
      const previousTransaction = await pool.query(
        'SELECT balance FROM transactions WHERE id < $1 ORDER BY id DESC LIMIT 1',
        [id]
      );

      let previousBalance = 0;
      if (previousTransaction.rows.length > 0) {
        previousBalance = parseFloat(previousTransaction.rows[0].balance);
      }

      // Calculate new balance based on updated transaction
      let newBalance;
      if (type === 'Debit') {
        newBalance = previousBalance - parseFloat(amount);
      } else if (type === 'Credit') {
        newBalance = previousBalance + parseFloat(amount);
      } else {
        throw new Error('Invalid transaction type. Must be "Debit" or "Credit"');
      }

      // Update the transaction
      const result = await pool.query(
        `UPDATE transactions 
         SET date = $1, type = $2, category_id = $3, payment_type = $4, 
             cheque_number = $5, amount = $6, balance = $7
         WHERE id = $8
         RETURNING id, date, type, category_id, payment_type, cheque_number, amount, balance, created_by, created_at`,
        [
          date,
          type,
          categoryId || null,
          paymentType,
          chequeNumber || null,
          amount,
          newBalance,
          id
        ]
      );

      if (result.rows.length === 0) {
        return null;
      }

      // Recalculate all subsequent transactions
      const subsequentTransactions = await pool.query(
        'SELECT id, type, amount FROM transactions WHERE id > $1 ORDER BY id ASC',
        [id]
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
      if (categoryId) {
        const categoryResult = await pool.query(
          'SELECT name FROM payables_categories WHERE id = $1',
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

      // Delete the transaction
      await pool.query('DELETE FROM transactions WHERE id = $1', [id]);

      // Recalculate all balances after this transaction
      // This is important to maintain balance accuracy
      const transactions = await pool.query(
        'SELECT id, type, amount FROM transactions WHERE id > $1 ORDER BY id ASC',
        [id]
      );

      let currentBalance = parseFloat(transaction.balance);
      if (transaction.type === 'Debit') {
        currentBalance = currentBalance + parseFloat(transaction.amount);
      } else {
        currentBalance = currentBalance - parseFloat(transaction.amount);
      }

      // Update balances for all subsequent transactions
      for (const txn of transactions.rows) {
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

      return true;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Transaction;

