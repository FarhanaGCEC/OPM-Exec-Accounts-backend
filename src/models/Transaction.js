const { pool } = require('../config/database');
const { destroyTransactionChequeImage } = require('../services/cloudinaryTransactionUpload');

const TRANSACTION_SELECT_ATTACHMENT = `
          t.attachment_name,
          t.attachment_url,
          t.attachment_cloudinary_public_id,
          t.attachment_resource_type,`;

// Helper function to round to 2 decimal places
const roundToTwoDecimals = (value) => {
  return Math.round(parseFloat(value) * 100) / 100;
};

const normalizeTransactionTime = (value) => {
  if (value == null || String(value).trim() === '') return '00:00:00';
  const raw = String(value).trim();
  const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) {
    throw new Error('transactionTime must be in HH:mm or HH:mm:ss format');
  }
  const hh = match[1].padStart(2, '0');
  const mm = match[2];
  const ss = match[3] || '00';
  return `${hh}:${mm}:${ss}`;
};

class Transaction {
  // Get the latest balance (by date, then by id for same date)
  static async getLatestBalance() {
    try {
      const result = await pool.query(
        'SELECT balance FROM transactions ORDER BY date DESC, transaction_time DESC, id DESC LIMIT 1'
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
         ORDER BY date DESC, transaction_time DESC, id DESC LIMIT 1`,
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
    try {
      await queryFn(`
UPDATE transactions AS t
INNER JOIN (
  SELECT
    id,
    ROUND(
      SUM(
        CASE
          WHEN type = 'Debit' THEN -CAST(amount AS DECIMAL(19,4))
          WHEN type = 'Credit' THEN CAST(amount AS DECIMAL(19,4))
          ELSE 0
        END
      ) OVER (
        ORDER BY \`date\` ASC, transaction_time ASC, id ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ),
      2
    ) AS running_bal
  FROM transactions
) AS x ON t.id = x.id
SET t.balance = x.running_bal
      `);
      const tail = await queryFn(
        'SELECT balance FROM transactions ORDER BY `date` DESC, transaction_time DESC, id DESC LIMIT 1'
      );
      if (tail.rows.length === 0) {
        return 0;
      }
      return roundToTwoDecimals(parseFloat(tail.rows[0].balance));
    } catch (e) {
      console.warn(
        'Transaction._recalculateAllBalancesQuery: window UPDATE failed, using row-by-row:',
        e && e.message ? e.message : e
      );
    }

    const result = await queryFn(
      'SELECT id, type, amount FROM transactions ORDER BY date ASC, transaction_time ASC, id ASC'
    );

    let runningBalance = 0;
    for (const txn of result.rows) {
      if (txn.type === 'Debit') {
        runningBalance = runningBalance - parseFloat(txn.amount);
      } else if (txn.type === 'Credit') {
        runningBalance = runningBalance + parseFloat(txn.amount);
      }

      runningBalance = roundToTwoDecimals(runningBalance);

      await queryFn('UPDATE transactions SET balance = ? WHERE id = ?', [
        runningBalance,
        txn.id
      ]);
    }

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
          t.transaction_time,
          t.type,
          t.category_id,
          t.category_type,
          COALESCE(pc.name, rc.name) as category_name,
          t.payment_type,
          t.cheque_number,
          t.amount,
          t.balance,
          t.remarks,
${TRANSACTION_SELECT_ATTACHMENT}
          t.created_by,
          u.username as created_by_username,
          t.created_at
        FROM transactions t
        LEFT JOIN payables_categories pc ON t.category_id = pc.id AND t.category_type = 'payable'
        LEFT JOIN receivables_categories rc ON t.category_id = rc.id AND t.category_type = 'receivable'
        LEFT JOIN users u ON t.created_by = u.id
        ORDER BY t.date ASC, t.transaction_time ASC, t.id ASC
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
          t.transaction_time,
          t.type,
          t.category_id,
          t.category_type,
          COALESCE(pc.name, rc.name) as category_name,
          t.payment_type,
          t.cheque_number,
          t.amount,
          t.balance,
          t.remarks,
${TRANSACTION_SELECT_ATTACHMENT}
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
      const {
        date,
        transactionTime,
        type,
        categoryId,
        paymentType,
        chequeNumber,
        amount,
        remarks,
        createdBy
      } = transactionData;
      const normalizedTransactionTime = normalizeTransactionTime(transactionTime);
      
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

      // Insert transaction
      await pool.query(
        `INSERT INTO transactions 
         (date, transaction_time, type, category_id, category_type, payment_type, cheque_number, amount, balance, remarks, created_by) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          date,
          normalizedTransactionTime,
          type,
          categoryId || null,
          categoryType,
          paymentType,
          chequeNumber || null,
          roundedAmount,
          0,
          remarks || null,
          createdBy || null
        ]
      );
      const insertResult = await pool.query(
        'SELECT id FROM transactions WHERE id = LAST_INSERT_ID()'
      );

      const insertedId = insertResult.rows[0].id;
      await this.recalculateAllBalances();

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
        `SELECT id, date, transaction_time, type, category_id, category_type, payment_type, cheque_number, amount, balance, remarks,
         attachment_name, attachment_url, attachment_cloudinary_public_id, attachment_resource_type,
         created_by, created_at FROM transactions WHERE id = ?`,
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
   * @param {{ fetchRows?: boolean }} [options] fetchRows false skips N+1 getById calls after insert (faster large bulk)
   * @returns {Promise<Array<Record<string, unknown>>>} Created rows with category_name / created_by_username like create()
   */
  static async createMany(normalizedRows, createdBy, options = {}) {
    const fetchRows = options.fetchRows !== false;
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
      'SELECT id, date, transaction_time, type, amount FROM transactions ORDER BY date ASC, transaction_time ASC, id ASC'
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
          transactionTime: normalizeTransactionTime(n.transactionTime),
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
           (date, transaction_time, type, category_id, category_type, payment_type, cheque_number, amount, balance, remarks, created_by) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.date,
            item.transactionTime,
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

    if (!fetchRows) {
      return insertedIds.map((id) => ({
        id: typeof id === 'bigint' ? Number(id) : id,
        _minimal: true
      }));
    }

    const details = await Promise.all(
      insertedIds.map((id) => this.getById(typeof id === 'bigint' ? Number(id) : id))
    );
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

      const {
        date,
        transactionTime,
        type,
        categoryId,
        paymentType,
        chequeNumber,
        amount,
        remarks
      } = transactionData;
      const normalizedTransactionTime = normalizeTransactionTime(transactionTime);

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

      // Update the transaction
      const updateResult = await pool.query(
        `UPDATE transactions 
         SET date = ?, transaction_time = ?, type = ?, category_id = ?, category_type = ?, payment_type = ?, 
             cheque_number = ?, amount = ?, balance = ?, remarks = ?
         WHERE id = ?`,
        [
          date,
          normalizedTransactionTime,
          type,
          categoryId || null,
          categoryType,
          paymentType,
          chequeNumber || null,
          roundedAmount,
          oldTransaction.balance,
          remarks || null,
          id
        ]
      );

      if (updateResult.affectedRows === 0) {
        return null;
      }

      await this.recalculateAllBalances();

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
        `SELECT id, date, transaction_time, type, category_id, category_type, payment_type, cheque_number, amount, balance, remarks,
         attachment_name, attachment_url, attachment_cloudinary_public_id, attachment_resource_type,
         created_by, created_at FROM transactions WHERE id = ?`,
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

  static async setChequeAttachment(
    id,
    { attachmentName, attachmentUrl, attachmentCloudinaryPublicId, attachmentResourceType }
  ) {
    await pool.query(
      `UPDATE transactions
       SET attachment_name = ?, attachment_url = ?, attachment_cloudinary_public_id = ?, attachment_resource_type = ?
       WHERE id = ?`,
      [
        attachmentName,
        attachmentUrl,
        attachmentCloudinaryPublicId,
        attachmentResourceType || 'image',
        id
      ]
    );
    return this.getById(id);
  }

  static async clearChequeAttachment(id) {
    await pool.query(
      `UPDATE transactions
       SET attachment_name = NULL, attachment_url = NULL,
           attachment_cloudinary_public_id = NULL, attachment_resource_type = NULL
       WHERE id = ?`,
      [id]
    );
    return this.getById(id);
  }

  // Delete a transaction and recalculate balances
  static async delete(id) {
    try {
      const transaction = await this.getById(id);
      if (!transaction) {
        return false;
      }
      if (transaction.attachment_cloudinary_public_id) {
        await destroyTransactionChequeImage(
          transaction.attachment_cloudinary_public_id,
          transaction.attachment_resource_type || 'image'
        );
      }
      await pool.query('DELETE FROM transactions WHERE id = ?', [id]);
      await this.recalculateAllBalances();
      return true;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Delete multiple ledger rows by numeric id (AED `transactions` table only).
   * Uses one DELETE + one balance pass — calling delete() per row rescans/updates every
   * subsequent transaction each time, which is O(n²) and can time out the client with no JSON.
   * @param {number[]} ids
   * @returns {{ deleted: number, missingIds: number[] }}
   */
  static async deleteManyByIds(ids) {
    const unique = [
      ...new Set(
        (ids || [])
          .map((id) => parseInt(id, 10))
          .filter((n) => Number.isInteger(n) && n > 0)
      )
    ];
    if (unique.length === 0) {
      return { deleted: 0, missingIds: [] };
    }

    const placeholders = unique.map(() => '?').join(',');
    const r = await pool.query(
      `SELECT id FROM transactions WHERE id IN (${placeholders}) ORDER BY date DESC, transaction_time DESC, id DESC`,
      unique
    );

    const toNum = (v) => (typeof v === 'bigint' ? Number(v) : v);
    const foundSet = new Set(r.rows.map((row) => toNum(row.id)));
    const missingIds = unique.filter((id) => !foundSet.has(id));

    if (r.rows.length === 0) {
      return { deleted: 0, missingIds };
    }

    const idsToDelete = r.rows.map((row) => toNum(row.id));
    const conn = await pool.connect();
    await conn.beginTransaction();
    try {
      const delPh = idsToDelete.map(() => '?').join(',');
      await conn.query(
        `DELETE FROM transactions WHERE id IN (${delPh})`,
        idsToDelete
      );
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

    return { deleted: idsToDelete.length, missingIds };
  }
}

module.exports = Transaction;

