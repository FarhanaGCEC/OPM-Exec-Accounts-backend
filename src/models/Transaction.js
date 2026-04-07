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
         WHERE date < ?
         ORDER BY date DESC, id DESC LIMIT 1`,
        [date]
      );
      return result.rows.length > 0 ? parseFloat(result.rows[0].balance) : 0;
    } catch (error) {
      throw error;
    }
  }

  /**
   * @param {(sql: string, params?: any[]) => Promise<{ rows: any[] }>} queryFn
   */
  static async _recalculateAllBalancesQuery(queryFn) {
    const result = await queryFn(
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

      runningBalance = roundToTwoDecimals(runningBalance);

      updates.push(
        queryFn('UPDATE transactions SET balance = ? WHERE id = ?', [runningBalance, txn.id])
      );
    }

    await Promise.all(updates);
    return roundToTwoDecimals(runningBalance);
  }

  // Recalculate all balances chronologically (by date, then by id)
  static async recalculateAllBalances() {
    try {
      return await this._recalculateAllBalancesQuery((sql, params = []) =>
        pool.query(sql, params)
      );
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
          `SELECT id FROM ${tableName} WHERE id = ?`,
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
         WHERE date < ?
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
         WHERE date = ?
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      const insertResult = await pool.query(
        'SELECT id FROM transactions WHERE id = LAST_INSERT_ID()'
      );

      // Recalculate all subsequent transactions (by date, then by id)
      const insertedId = insertResult.rows[0].id;
      const subsequentTransactions = await pool.query(
        `SELECT id, type, amount FROM transactions 
         WHERE date > ? OR (date = ? AND id > ?)
         ORDER BY date ASC, id ASC`,
        [date, date, insertedId]
      );

      let currentBalance = newBalance;
      for (const txn of subsequentTransactions.rows) {
        if (txn.type === 'Debit') {
          currentBalance = currentBalance - parseFloat(txn.amount);
        } else {
          currentBalance = currentBalance + parseFloat(txn.amount);
        }

        await pool.query(
          'UPDATE transactions SET balance = ? WHERE id = ?',
          [currentBalance, txn.id]
        );
      }

      // Get category name if category_id exists
      let categoryName = null;
      if (categoryId && categoryType) {
        const tableName = categoryType === 'payable' ? 'payables_categories' : 'receivables_categories';
        const categoryResult = await pool.query(
          `SELECT name FROM ${tableName} WHERE id = ?`,
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
          'SELECT username FROM users WHERE id = ?',
          [createdBy]
        );
        if (userResult.rows.length > 0) {
          createdByUsername = userResult.rows[0].username;
        }
      }

      const fetchResult = await pool.query(
        'SELECT id, date, type, category_id, category_type, payment_type, cheque_number, amount, balance, remarks, created_by, created_at FROM transactions WHERE id = ?',
        [insertedId]
      );
      const transaction = fetchResult.rows[0];
      return {
        ...transaction,
        category_name: categoryName,
        created_by_username: createdByUsername
      };
    } catch (error) {
      throw error;
    }
  }

  /** Normalize DATE from DB or string to YYYY-MM-DD */
  static _toYmd(d) {
    if (d == null) return '';
    if (d instanceof Date) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    const s = String(d);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
  }

  /**
   * Insert many transactions in chronological order (existing rows on each date first, then batch rows in request order),
   * then recalculate all balances. Runs in one DB transaction.
   * @param {Array<{ date: string, type: string, categoryId: number|null, paymentType: string, chequeNumber: string|null, amount: number, remarks: string|null }>} normalizedRows
   * @param {number|null} createdBy
   * @returns {Promise<Array<Record<string, unknown>>>} Created rows with category_name / created_by_username like create()
   */
  static async createMany(normalizedRows, createdBy) {
    if (!normalizedRows.length) {
      return [];
    }

    for (const row of normalizedRows) {
      const { type, categoryId } = row;
      let categoryType = null;
      if (categoryId) {
        if (type === 'Debit') {
          categoryType = 'payable';
        } else if (type === 'Credit') {
          categoryType = 'receivable';
        }
      }

      if (categoryId && categoryType) {
        const tableName =
          categoryType === 'payable' ? 'payables_categories' : 'receivables_categories';
        const categoryResult = await pool.query(
          `SELECT id FROM ${tableName} WHERE id = ?`,
          [categoryId]
        );
        if (categoryResult.rows.length === 0) {
          throw new Error(
            `Category ID ${categoryId} not found in ${categoryType} categories`
          );
        }
      }
    }

    const existingResult = await pool.query(
      'SELECT id, date, type, amount FROM transactions ORDER BY date ASC, id ASC'
    );
    const existing = existingResult.rows;

    const newByDate = new Map();
    for (let i = 0; i < normalizedRows.length; i++) {
      const row = normalizedRows[i];
      const d = Transaction._toYmd(row.date);
      if (!newByDate.has(d)) {
        newByDate.set(d, []);
      }
      newByDate.get(d).push({ ...row, date: d, _batchOrder: i });
    }

    const dateSet = new Set();
    for (const e of existing) {
      dateSet.add(Transaction._toYmd(e.date));
    }
    for (const d of newByDate.keys()) {
      dateSet.add(d);
    }
    const sortedDates = [...dateSet].sort();

    const toInsert = [];
    for (const date of sortedDates) {
      const exForDate = existing.filter((e) => Transaction._toYmd(e.date) === date);
      for (const e of exForDate) {
        toInsert.push({
          kind: 'existing',
          id: e.id,
          date
        });
      }
      const batchForDate = newByDate.get(date) || [];
      batchForDate.sort((a, b) => a._batchOrder - b._batchOrder);
      for (const n of batchForDate) {
        toInsert.push({
          kind: 'new',
          date: n.date,
          type: n.type,
          categoryId: n.categoryId,
          paymentType: n.paymentType,
          chequeNumber: n.chequeNumber,
          amount: n.amount,
          remarks: n.remarks
        });
      }
    }

    const insertedIds = [];
    const conn = await pool.connect();
    await conn.beginTransaction();
    try {
      for (const item of toInsert) {
        if (item.kind !== 'new') continue;

        const roundedAmount = roundToTwoDecimals(item.amount);
        let categoryType = null;
        if (item.categoryId) {
          if (item.type === 'Debit') {
            categoryType = 'payable';
          } else if (item.type === 'Credit') {
            categoryType = 'receivable';
          }
        }

        await conn.query(
          `INSERT INTO transactions 
           (date, type, category_id, category_type, payment_type, cheque_number, amount, balance, remarks, created_by) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.date,
            item.type,
            item.categoryId || null,
            categoryType,
            item.paymentType,
            item.chequeNumber || null,
            roundedAmount,
            0,
            item.remarks || null,
            createdBy || null
          ]
        );
        const insertResult = await conn.query(
          'SELECT id FROM transactions WHERE id = LAST_INSERT_ID()'
        );
        insertedIds.push(insertResult.rows[0].id);
      }

      await Transaction._recalculateAllBalancesQuery((sql, params = []) =>
        conn.query(sql, params)
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const details = await Promise.all(insertedIds.map((id) => this.getById(id)));
    return details.filter(Boolean);
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
          `SELECT id FROM ${tableName} WHERE id = ?`,
          [categoryId]
        );
        if (categoryResult.rows.length === 0) {
          throw new Error(`Category ID ${categoryId} not found in ${categoryType} categories`);
        }
      }

      // Get balance before this transaction's date (chronologically, excluding current transaction)
      const previousBalance = await pool.query(
        `SELECT balance FROM transactions 
         WHERE (date < ? OR (date = ? AND id < ?))
         ORDER BY date DESC, id DESC LIMIT 1`,
        [date, date, id]
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
      const updateResult = await pool.query(
        `UPDATE transactions 
         SET date = ?, type = ?, category_id = ?, category_type = ?, payment_type = ?, 
             cheque_number = ?, amount = ?, balance = ?, remarks = ?
         WHERE id = ?`,
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

      if (updateResult.affectedRows === 0) {
        return null;
      }

      // Recalculate all subsequent transactions (by date, then by id)
      const subsequentTransactions = await pool.query(
        `SELECT id, type, amount FROM transactions 
         WHERE date > ? OR (date = ? AND id > ?)
         ORDER BY date ASC, id ASC`,
        [date, date, id]
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
          'UPDATE transactions SET balance = ? WHERE id = ?',
          [currentBalance, txn.id]
        );
      }

      // Get category name if category_id exists
      let categoryName = null;
      if (categoryId && categoryType) {
        const tableName = categoryType === 'payable' ? 'payables_categories' : 'receivables_categories';
        const categoryResult = await pool.query(
          `SELECT name FROM ${tableName} WHERE id = ?`,
          [categoryId]
        );
        if (categoryResult.rows.length > 0) {
          categoryName = categoryResult.rows[0].name;
        }
      }

      // Fetch updated transaction
      const fetchResult = await pool.query(
        'SELECT id, date, type, category_id, category_type, payment_type, cheque_number, amount, balance, remarks, created_by, created_at FROM transactions WHERE id = ?',
        [id]
      );
      const updatedTransaction = fetchResult.rows[0];
      if (!updatedTransaction) return null;

      // Get created_by username if created_by exists
      let createdByUsername = null;
      if (updatedTransaction.created_by) {
        const userResult = await pool.query(
          'SELECT username FROM users WHERE id = ?',
          [updatedTransaction.created_by]
        );
        if (userResult.rows.length > 0) {
          createdByUsername = userResult.rows[0].username;
        }
      }

      const transaction = updatedTransaction;
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
         WHERE (date < ? OR (date = ? AND id < ?))
         ORDER BY date DESC, id DESC LIMIT 1`,
        [transactionDate, transactionDate, id]
      );

      let balanceBefore = 0;
      if (previousBalance.rows.length > 0) {
        balanceBefore = parseFloat(previousBalance.rows[0].balance);
      }

      // Delete the transaction
      await pool.query('DELETE FROM transactions WHERE id = ?', [id]);

      // Recalculate all subsequent transactions (by date, then by id)
      const subsequentTransactions = await pool.query(
        `SELECT id, type, amount FROM transactions 
         WHERE date > ? OR (date = ? AND id > ?)
         ORDER BY date ASC, id ASC`,
        [transactionDate, transactionDate, id]
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
          'UPDATE transactions SET balance = ? WHERE id = ?',
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

