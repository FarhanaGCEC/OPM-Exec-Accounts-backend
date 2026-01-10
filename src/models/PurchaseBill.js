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
        WHERE pb.id = $1
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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
         RETURNING id, bill_date, invoice_number, vendor_name, bill_number, payment_method, amount, description, payment_status, created_by, created_at, updated_at`,
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

      const bill = result.rows[0];
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
      let paramCount = 0;

      if (billDate !== undefined) {
        paramCount++;
        updateFields.push(`bill_date = $${paramCount}`);
        values.push(billDate);
      }

      if (invoiceNumber !== undefined) {
        paramCount++;
        updateFields.push(`invoice_number = $${paramCount}`);
        values.push(invoiceNumber || null);
      }

      if (vendorName !== undefined) {
        paramCount++;
        updateFields.push(`vendor_name = $${paramCount}`);
        values.push(vendorName || null);
      }

      if (billNumber !== undefined) {
        paramCount++;
        updateFields.push(`bill_number = $${paramCount}`);
        values.push(billNumber || null);
      }

      if (paymentMethod !== undefined) {
        paramCount++;
        updateFields.push(`payment_method = $${paramCount}`);
        values.push(paymentMethod || 'Credit Card');
      }

      if (amount !== undefined) {
        paramCount++;
        updateFields.push(`amount = $${paramCount}`);
        values.push(amount);
      }

      if (description !== undefined) {
        paramCount++;
        updateFields.push(`description = $${paramCount}`);
        values.push(description || null);
      }

      if (paymentStatus !== undefined) {
        paramCount++;
        updateFields.push(`payment_status = $${paramCount}`);
        values.push(paymentStatus || 'Pending');
      }

      if (updateFields.length === 0) {
        return await this.getById(id);
      }

      paramCount++;
      updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id);

      const result = await pool.query(
        `UPDATE purchase_bills 
         SET ${updateFields.join(', ')}
         WHERE id = $${paramCount}
         RETURNING id, bill_date, invoice_number, vendor_name, bill_number, payment_method, amount, description, payment_status, created_by, created_at, updated_at`,
        values
      );

      if (result.rows.length === 0) {
        return null;
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

      const bill = result.rows[0];
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
        'DELETE FROM purchase_bills WHERE id = $1 RETURNING id',
        [id]
      );

      return result.rows.length > 0;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = PurchaseBill;
