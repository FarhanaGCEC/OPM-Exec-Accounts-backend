const { pool } = require('../config/database');

class PurchaseBill {
  // Get all purchase bills
  static async getAll() {
    try {
      const result = await pool.query(`
        SELECT 
          pb.id,
          pb.bill_date,
          pb.invoice_number,
          pb.vendor_name,
          pb.bill_number,
          pb.payment_method,
          pb.amount,
          pb.description,
          pb.payment_status,
          pb.created_by,
          u.username as created_by_username,
          pb.created_at,
          pb.updated_at
        FROM purchase_bills pb
        LEFT JOIN users u ON pb.created_by = u.id
        ORDER BY pb.bill_date ASC, pb.created_at ASC
      `);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Get a single purchase bill by ID
  static async getById(id) {
    try {
      const result = await pool.query(`
        SELECT 
          pb.id,
          pb.bill_date,
          pb.invoice_number,
          pb.vendor_name,
          pb.bill_number,
          pb.payment_method,
          pb.amount,
          pb.description,
          pb.payment_status,
          pb.created_by,
          u.username as created_by_username,
          pb.created_at,
          pb.updated_at
        FROM purchase_bills pb
        LEFT JOIN users u ON pb.created_by = u.id
        WHERE pb.id = ?
      `, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Create a new purchase bill
  static async create(billData) {
    try {
      const { billDate, invoiceNumber, vendorName, billNumber, paymentMethod, amount, description, paymentStatus, createdBy } = billData;

      const result = await pool.query(
        `INSERT INTO purchase_bills 
         (bill_date, invoice_number, vendor_name, bill_number, payment_method, amount, description, payment_status, created_by) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          billDate,
          invoiceNumber || null,
          vendorName || null,
          billNumber || null,
          paymentMethod || 'Credit Card',
          amount,
          description || null,
          paymentStatus || 'Pending',
          createdBy || null
        ]
      );
      const fetchResult = await pool.query(
        'SELECT id, bill_date, invoice_number, vendor_name, bill_number, payment_method, amount, description, payment_status, created_by, created_at, updated_at FROM purchase_bills WHERE id = LAST_INSERT_ID()'
      );

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

      const bill = fetchResult.rows[0];
      return {
        ...bill,
        created_by_username: createdByUsername
      };
    } catch (error) {
      throw error;
    }
  }

  // Update a purchase bill
  static async update(id, billData) {
    try {
      const { billDate, invoiceNumber, vendorName, billNumber, paymentMethod, amount, description, paymentStatus } = billData;

      const updateFields = [];
      const values = [];

      if (billDate !== undefined) { updateFields.push('bill_date = ?'); values.push(billDate); }
      if (invoiceNumber !== undefined) { updateFields.push('invoice_number = ?'); values.push(invoiceNumber || null); }
      if (vendorName !== undefined) { updateFields.push('vendor_name = ?'); values.push(vendorName || null); }
      if (billNumber !== undefined) { updateFields.push('bill_number = ?'); values.push(billNumber || null); }
      if (paymentMethod !== undefined) { updateFields.push('payment_method = ?'); values.push(paymentMethod || 'Credit Card'); }
      if (amount !== undefined) { updateFields.push('amount = ?'); values.push(amount); }
      if (description !== undefined) { updateFields.push('description = ?'); values.push(description || null); }
      if (paymentStatus !== undefined) { updateFields.push('payment_status = ?'); values.push(paymentStatus || 'Pending'); }

      if (updateFields.length === 0) return await this.getById(id);

      updateFields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);

      const updateResult = await pool.query(
        `UPDATE purchase_bills SET ${updateFields.join(', ')} WHERE id = ?`,
        values
      );
      if (updateResult.affectedRows === 0) return null;

      const bill = await this.getById(id);
      if (!bill) return null;
      let createdByUsername = null;
      if (bill.created_by) {
        const userResult = await pool.query('SELECT username FROM users WHERE id = ?', [bill.created_by]);
        if (userResult.rows.length > 0) createdByUsername = userResult.rows[0].username;
      }
      return {
        ...bill,
        created_by_username: createdByUsername
      };
    } catch (error) {
      throw error;
    }
  }

  // Delete a purchase bill
  static async delete(id) {
    try {
      const result = await pool.query(
        'DELETE FROM purchase_bills WHERE id = ?',
        [id]
      );

      return result.affectedRows > 0;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = PurchaseBill;
