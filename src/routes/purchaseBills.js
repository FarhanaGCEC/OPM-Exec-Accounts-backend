const express = require('express');
const PurchaseBill = require('../models/PurchaseBill');
const { authenticateToken } = require('../middleware/auth');
const { formatAmount, roundToTwoDecimals } = require('../utils/formatAmount');

const router = express.Router();

// Get all purchase bills
router.get('/', authenticateToken, async (req, res) => {
  try {
    const bills = await PurchaseBill.getAll();
    res.json({
      success: true,
      data: bills.map(bill => {
        const formatted = { ...bill };
        formatted.amount = formatAmount(bill.amount);
        return formatted;
      })
    });
  } catch (error) {
    console.error('Error fetching purchase bills:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch purchase bills'
    });
  }
});

// Get a single purchase bill by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const bill = await PurchaseBill.getById(id);

    if (!bill) {
      return res.status(404).json({
        success: false,
        error: 'Purchase bill not found'
      });
    }

    const formattedBill = { ...bill };
    formattedBill.amount = formatAmount(bill.amount);
    res.json({
      success: true,
      data: formattedBill
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch purchase bill'
    });
  }
});

// Create a new purchase bill
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { bill_date, invoice_number, vendor_name, bill_number, payment_method, amount, description, payment_status } = req.body;

    // Validation
    if (!bill_date || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Bill date and amount are required'
      });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be greater than 0'
      });
    }

    // Round amount to 2 decimal places before saving
    const roundedAmount = roundToTwoDecimals(parsedAmount);

    // Convert date format if needed (DD/MM/YYYY or DD-MMM-YYYY to YYYY-MM-DD)
    let formattedDate = bill_date;
    if (typeof bill_date === 'string') {
      if (bill_date.includes('/')) {
        const parts = bill_date.split('/');
        if (parts.length === 3) {
          const [day, month, year] = parts;
          formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        }
      } else if (bill_date.includes('-') && !bill_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        // Handle format like "10-Jan-2024" or "DD-MM-YY"
        const months = {
          'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
          'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
        };
        const parts = bill_date.split('-');
        if (parts.length === 3) {
          const day = parts[0].padStart(2, '0');
          const month = months[parts[1]] || parts[1].padStart(2, '0');
          let year = parts[2];
          // Handle 2-digit year
          if (year.length === 2) {
            year = '20' + year;
          }
          formattedDate = `${year}-${month}-${day}`;
        }
      }
    }

    // Validate date
    const dateObj = new Date(formattedDate);
    if (isNaN(dateObj.getTime())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date format. Use YYYY-MM-DD, DD/MM/YYYY, or DD-MM-YY'
      });
    }

    // Validate payment_status if provided
    const validStatuses = ['Pending', 'Paid', 'Partially Paid'];
    const status = payment_status || 'Pending';
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Payment status must be one of: ${validStatuses.join(', ')}`
      });
    }

    // Get user ID from JWT token
    const createdBy = req.user ? req.user.id : null;

    const bill = await PurchaseBill.create({
      billDate: formattedDate,
      invoiceNumber: invoice_number || null,
      vendorName: vendor_name || null,
      billNumber: bill_number || null,
      paymentMethod: payment_method || 'Credit Card',
      amount: roundedAmount,
      description: description || null,
      paymentStatus: status,
      createdBy: createdBy
    });

    const formattedBill = { ...bill };
    formattedBill.amount = formatAmount(bill.amount);
    res.status(201).json({
      success: true,
      message: 'Purchase bill created successfully',
      data: formattedBill
    });
  } catch (error) {
    console.error('Error creating purchase bill:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create purchase bill'
    });
  }
});

// Update a purchase bill (full update)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { bill_date, invoice_number, vendor_name, bill_number, payment_method, amount, description, payment_status } = req.body;

    // Validation
    if (!bill_date || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Bill date and amount are required'
      });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be greater than 0'
      });
    }

    // Round amount to 2 decimal places before saving
    const roundedAmount = roundToTwoDecimals(parsedAmount);

    // Convert date format if needed
    let formattedDate = bill_date;
    if (typeof bill_date === 'string') {
      if (bill_date.includes('/')) {
        const parts = bill_date.split('/');
        if (parts.length === 3) {
          const [day, month, year] = parts;
          formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        }
      } else if (bill_date.includes('-') && !bill_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const months = {
          'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
          'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
        };
        const parts = bill_date.split('-');
        if (parts.length === 3) {
          const day = parts[0].padStart(2, '0');
          const month = months[parts[1]] || parts[1].padStart(2, '0');
          let year = parts[2];
          if (year.length === 2) {
            year = '20' + year;
          }
          formattedDate = `${year}-${month}-${day}`;
        }
      }
    }

    // Validate date
    const dateObj = new Date(formattedDate);
    if (isNaN(dateObj.getTime())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date format. Use YYYY-MM-DD, DD/MM/YYYY, or DD-MM-YY'
      });
    }

    // Validate payment_status
    const validStatuses = ['Pending', 'Paid', 'Partially Paid'];
    const status = payment_status || 'Pending';
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Payment status must be one of: ${validStatuses.join(', ')}`
      });
    }

    const bill = await PurchaseBill.update(id, {
      billDate: formattedDate,
      invoiceNumber: invoice_number || null,
      vendorName: vendor_name || null,
      billNumber: bill_number || null,
      paymentMethod: payment_method || 'Credit Card',
      amount: roundedAmount,
      description: description || null,
      paymentStatus: status
    });

    if (!bill) {
      return res.status(404).json({
        success: false,
        error: 'Purchase bill not found'
      });
    }

    const formattedBill = { ...bill };
    formattedBill.amount = formatAmount(bill.amount);
    res.json({
      success: true,
      message: 'Purchase bill updated successfully',
      data: formattedBill
    });
  } catch (error) {
    console.error('Error updating purchase bill:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update purchase bill'
    });
  }
});

// Partial update a purchase bill
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { bill_date, invoice_number, vendor_name, bill_number, payment_method, amount, description, payment_status } = req.body;

    const updateData = {};

    // Validate and format bill_date if provided
    if (bill_date !== undefined) {
      let formattedDate = bill_date;
      if (typeof bill_date === 'string') {
        if (bill_date.includes('/')) {
          const parts = bill_date.split('/');
          if (parts.length === 3) {
            const [day, month, year] = parts;
            formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }
        } else if (bill_date.includes('-') && !bill_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const months = {
            'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
            'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
          };
          const parts = bill_date.split('-');
          if (parts.length === 3) {
            const day = parts[0].padStart(2, '0');
            const month = months[parts[1]] || parts[1].padStart(2, '0');
            let year = parts[2];
            if (year.length === 2) {
              year = '20' + year;
            }
            formattedDate = `${year}-${month}-${day}`;
          }
        }
      }

      // Validate date
      const dateObj = new Date(formattedDate);
      if (isNaN(dateObj.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid date format. Use YYYY-MM-DD, DD/MM/YYYY, or DD-MM-YY'
        });
      }

      updateData.billDate = formattedDate;
    }

    // Validate and format amount if provided
    if (amount !== undefined) {
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Amount must be greater than 0'
        });
      }
      updateData.amount = roundToTwoDecimals(parsedAmount);
    }

    // Add optional fields
    if (invoice_number !== undefined) {
      updateData.invoiceNumber = invoice_number || null;
    }
    if (vendor_name !== undefined) {
      updateData.vendorName = vendor_name || null;
    }
    if (bill_number !== undefined) {
      updateData.billNumber = bill_number || null;
    }
    if (payment_method !== undefined) {
      updateData.paymentMethod = payment_method || 'Credit Card';
    }
    if (description !== undefined) {
      updateData.description = description || null;
    }
    if (payment_status !== undefined) {
      const validStatuses = ['Pending', 'Paid', 'Partially Paid'];
      if (!validStatuses.includes(payment_status)) {
        return res.status(400).json({
          success: false,
          error: `Payment status must be one of: ${validStatuses.join(', ')}`
        });
      }
      updateData.paymentStatus = payment_status;
    }

    const bill = await PurchaseBill.update(id, updateData);

    if (!bill) {
      return res.status(404).json({
        success: false,
        error: 'Purchase bill not found'
      });
    }

    const formattedBill = { ...bill };
    formattedBill.amount = formatAmount(bill.amount);
    res.json({
      success: true,
      message: 'Purchase bill updated successfully',
      data: formattedBill
    });
  } catch (error) {
    console.error('Error updating purchase bill:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update purchase bill'
    });
  }
});

// Delete a purchase bill
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await PurchaseBill.delete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Purchase bill not found'
      });
    }

    res.json({
      success: true,
      message: 'Purchase bill deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting purchase bill:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete purchase bill'
    });
  }
});

module.exports = router;
