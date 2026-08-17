const express = require('express');
const CreditCardPayment = require('../models/CreditCardPayment');
const { authenticateToken } = require('../middleware/auth');
const { USER_ROLES } = require('../constants/roles');
const changeRequestEvents = require('../services/changeRequestEvents');
const {
  queueCreditCardPaymentDelete,
  assertStandardUserCanMutateCreditCardPayment,
} = require('../controllers/creditCardPaymentChangeRequestQueue');
const { formatAmount, roundToTwoDecimals } = require('../utils/formatAmount');
const { normalizePaymentType, VALID_PAYMENT_TYPES } = require('../utils/creditCardPaymentPayload');
const {
  syncPaymentCreated,
  syncPaymentUpdated,
  syncPaymentDeleted,
} = require('../services/creditCardPaymentStatementSync');
const { maskCardNumber } = require('../utils/maskCardNumber');

const router = express.Router();

function toYmd(d) {
  if (d == null) return null;
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const s = String(d);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

function parseYearMonthsQuery(year, months) {
  let parsedYear;
  if (year !== undefined && year !== null && String(year).trim() !== '') {
    parsedYear = Number(year);
    if (!Number.isInteger(parsedYear) || parsedYear < 1900 || parsedYear > 9999) {
      return { ok: false, error: 'Invalid year. Expected a valid 4-digit year.' };
    }
  }

  if (months === undefined || months === null || String(months).trim() === '') {
    return { ok: true, year: parsedYear, monthList: undefined };
  }

  const monthNumbers = String(months)
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  const monthList = [];
  for (const raw of monthNumbers) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 12) {
      return {
        ok: false,
        error: 'Invalid months. Expected 1-12 or comma-separated list (e.g. 7,8).',
      };
    }
    if (!monthList.includes(n)) monthList.push(n);
  }

  return { ok: true, year: parsedYear, monthList };
}

function formatPaymentForApi(payment) {
  const paymentType = payment.payment_type || 'paid';
  return {
    id: payment.id,
    payment_date: toYmd(payment.payment_date),
    card_holder: payment.card_holder || payment.customer_name || null,
    card_no: maskCardNumber(payment.card_number || payment.card_no || null),
    amount: formatAmount(payment.amount),
    remarks: payment.remarks || null,
    paid_against: payment.paid_against || null,
    paidAgainst: payment.paid_against || null,
    payment_type: paymentType,
    paymentType,
    credit_card_id: payment.credit_card_id || payment.card_id || null,
    issuing_bank: payment.issuing_bank || null,
    created_at: payment.created_at,
    updated_at: payment.updated_at
  };
}

// Get all credit card payments
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { year, months, paidAgainst, paid_against, paymentType, payment_type } = req.query;
    const normalizedPaidAgainst = paidAgainst ?? paid_against;
    let normalizedPaymentType;
    try {
      normalizedPaymentType = normalizePaymentType(paymentType ?? payment_type);
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: e.message || `Invalid payment_type. Expected one of: ${VALID_PAYMENT_TYPES.join(', ')}`
      });
    }

    const parsedMonths = parseYearMonthsQuery(year, months);
    if (!parsedMonths.ok) {
      return res.status(400).json({
        success: false,
        error: parsedMonths.error,
      });
    }

    const payments = await CreditCardPayment.getAll({
      year: parsedMonths.year,
      months: parsedMonths.monthList,
      paidAgainst: normalizedPaidAgainst,
      paymentType: normalizedPaymentType || undefined
    });
    res.json({
      success: true,
      data: payments.map((payment) => formatPaymentForApi(payment))
    });
  } catch (error) {
    console.error('Error fetching credit card payments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch credit card payments'
    });
  }
});

// Get a single credit card payment by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const payment = await CreditCardPayment.getById(id);

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Credit card payment not found'
      });
    }

    res.json({
      success: true,
      data: formatPaymentForApi(payment)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch credit card payment'
    });
  }
});

function notifyAdminPaymentCreated(req, payment) {
  if (!req.user || req.user.role !== USER_ROLES.USER) return;
  changeRequestEvents.emit('new_request', {
    requestId: null,
    action: 'create',
    resourceType: 'credit_card_payment',
    resourceId: String(payment.id),
    requesterId: req.user.id,
    requesterUsername: req.user.username,
    note: null,
    status: 'recorded',
    summary: {
      payment_date: payment.payment_date,
      amount: payment.amount,
      paid_against: payment.paid_against || null,
      payment_type: payment.payment_type || 'paid',
    },
  });
}

// Create a new credit card payment
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      payment_date,
      credit_card_id,
      card_holder,
      card_no,
      amount,
      remarks,
      paid_against,
      paidAgainst,
      payment_type,
      paymentType,
    } = req.body;

    // Validation
    if (!payment_date || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Payment date and amount are required'
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

    let normalizedPaymentType = 'paid';
    try {
      normalizedPaymentType = normalizePaymentType(payment_type ?? paymentType) || 'paid';
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: e.message || `Invalid payment_type. Expected one of: ${VALID_PAYMENT_TYPES.join(', ')}`
      });
    }

    // Convert date format if needed (DD/MM/YYYY or DD-MM-YY to YYYY-MM-DD)
    let formattedDate = payment_date;
    if (typeof payment_date === 'string') {
      if (payment_date.includes('/')) {
        const parts = payment_date.split('/');
        if (parts.length === 3) {
          const [day, month, year] = parts;
          formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        }
      } else if (payment_date.includes('-') && !payment_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        // Handle format like "10-Jan-2024" or "DD-MM-YY"
        const months = {
          'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
          'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
        };
        const parts = payment_date.split('-');
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

    // Get user ID from JWT token
    const createdBy = req.user ? req.user.id : null;

    const payment = await CreditCardPayment.create({
      paymentDate: formattedDate,
      creditCardId: credit_card_id || null,
      customerName: card_holder || null, // Keep for backward compatibility
      paymentMethod: 'Credit Card',
      paymentType: normalizedPaymentType,
      amount: roundedAmount,
      remarks: remarks || null,
      paidAgainst: paidAgainst ?? paid_against ?? null,
      createdBy: createdBy
    });

    try {
      await syncPaymentCreated(payment);
    } catch (syncErr) {
      console.error('Statement sync failed after credit card payment create:', syncErr);
      return res.status(201).json({
        success: true,
        message: 'Credit card payment created successfully, but statement sync failed',
        warning: syncErr.message || 'Failed to reflect payment on card statement',
        data: formatPaymentForApi(payment)
      });
    }

    notifyAdminPaymentCreated(req, payment);

    res.status(201).json({
      success: true,
      message: 'Credit card payment created successfully',
      data: formatPaymentForApi(payment)
    });
  } catch (error) {
    console.error('Error creating credit card payment:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create credit card payment'
    });
  }
});

// Update a credit card payment (full update)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user && req.user.role === USER_ROLES.USER) {
      const row = await CreditCardPayment.getById(id);
      if (!row) {
        return res.status(404).json({
          success: false,
          error: 'Credit card payment not found'
        });
      }
      try {
        await assertStandardUserCanMutateCreditCardPayment(req, row);
      } catch (e) {
        const status = e.status || 500;
        return res.status(status).json({
          success: false,
          code: e.code,
          error: e.message,
        });
      }
    }
    const { payment_date, credit_card_id, card_holder, card_no, amount, remarks, paid_against, paidAgainst, payment_type, paymentType } = req.body;
    const hasRemarksField = Object.prototype.hasOwnProperty.call(req.body || {}, 'remarks');

    const updateData = {};

    // Validate and format payment_date if provided
    if (payment_date !== undefined) {
      let formattedDate = payment_date;
      if (typeof payment_date === 'string') {
        if (payment_date.includes('/')) {
          const parts = payment_date.split('/');
          if (parts.length === 3) {
            const [day, month, year] = parts;
            formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }
        } else if (payment_date.includes('-') && !payment_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const months = {
            'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
            'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
          };
          const parts = payment_date.split('-');
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

      updateData.paymentDate = formattedDate;
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
    if (credit_card_id !== undefined) {
      updateData.creditCardId = credit_card_id || null;
    }
    if (card_holder !== undefined) {
      updateData.customerName = card_holder || null; // Keep for backward compatibility
    }
    if (hasRemarksField) {
      updateData.remarks = remarks || null;
    } else {
      // Frontend edit form often omits remarks when user clears it; treat as clear.
      updateData.remarks = null;
    }
    if (paidAgainst !== undefined || paid_against !== undefined) {
      updateData.paidAgainst = (paidAgainst ?? paid_against) || null;
    }
    if (payment_type !== undefined || paymentType !== undefined) {
      try {
        updateData.paymentType = normalizePaymentType(payment_type ?? paymentType) || 'paid';
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: e.message || `Invalid payment_type. Expected one of: ${VALID_PAYMENT_TYPES.join(', ')}`
        });
      }
    }

    const previousPayment = await CreditCardPayment.getById(id);
    const payment = await CreditCardPayment.update(id, updateData);

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Credit card payment not found'
      });
    }

    try {
      await syncPaymentUpdated(previousPayment, payment);
    } catch (syncErr) {
      console.error('Statement sync failed after credit card payment update:', syncErr);
      return res.json({
        success: true,
        message: 'Credit card payment updated successfully, but statement sync failed',
        warning: syncErr.message || 'Failed to reflect payment on card statement',
        data: formatPaymentForApi(payment)
      });
    }

    res.json({
      success: true,
      message: 'Credit card payment updated successfully',
      data: formatPaymentForApi(payment)
    });
  } catch (error) {
    console.error('Error updating credit card payment:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update credit card payment'
    });
  }
});

// Partial update a credit card payment
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user && req.user.role === USER_ROLES.USER) {
      const row = await CreditCardPayment.getById(id);
      if (!row) {
        return res.status(404).json({
          success: false,
          error: 'Credit card payment not found'
        });
      }
      try {
        await assertStandardUserCanMutateCreditCardPayment(req, row);
      } catch (e) {
        const status = e.status || 500;
        return res.status(status).json({
          success: false,
          code: e.code,
          error: e.message,
        });
      }
    }
    const { payment_date, credit_card_id, card_holder, card_no, amount, remarks, paid_against, paidAgainst, payment_type, paymentType } = req.body;
    const hasRemarksField = Object.prototype.hasOwnProperty.call(req.body || {}, 'remarks');

    const updateData = {};

    // Validate and format payment_date if provided
    if (payment_date !== undefined) {
      let formattedDate = payment_date;
      if (typeof payment_date === 'string') {
        if (payment_date.includes('/')) {
          const parts = payment_date.split('/');
          if (parts.length === 3) {
            const [day, month, year] = parts;
            formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }
        } else if (payment_date.includes('-') && !payment_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const months = {
            'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
            'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
          };
          const parts = payment_date.split('-');
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

      updateData.paymentDate = formattedDate;
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
    if (credit_card_id !== undefined) {
      updateData.creditCardId = credit_card_id || null;
    }
    if (card_holder !== undefined) {
      updateData.customerName = card_holder || null;
    }
    if (hasRemarksField) {
      updateData.remarks = remarks || null;
    } else {
      // Frontend edit form often omits remarks when user clears it; treat as clear.
      updateData.remarks = null;
    }
    if (paidAgainst !== undefined || paid_against !== undefined) {
      updateData.paidAgainst = (paidAgainst ?? paid_against) || null;
    }
    if (payment_type !== undefined || paymentType !== undefined) {
      try {
        updateData.paymentType = normalizePaymentType(payment_type ?? paymentType) || 'paid';
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: e.message || `Invalid payment_type. Expected one of: ${VALID_PAYMENT_TYPES.join(', ')}`
        });
      }
    }

    const previousPayment = await CreditCardPayment.getById(id);
    const payment = await CreditCardPayment.update(id, updateData);

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Credit card payment not found'
      });
    }

    try {
      await syncPaymentUpdated(previousPayment, payment);
    } catch (syncErr) {
      console.error('Statement sync failed after credit card payment update:', syncErr);
      return res.json({
        success: true,
        message: 'Credit card payment updated successfully, but statement sync failed',
        warning: syncErr.message || 'Failed to reflect payment on card statement',
        data: formatPaymentForApi(payment)
      });
    }

    res.json({
      success: true,
      message: 'Credit card payment updated successfully',
      data: formatPaymentForApi(payment)
    });
  } catch (error) {
    console.error('Error updating credit card payment:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update credit card payment'
    });
  }
});

// Delete a credit card payment
router.delete('/:id', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === USER_ROLES.USER) {
    return queueCreditCardPaymentDelete(req, res);
  }
  try {
    const { id } = req.params;
    const existing = await CreditCardPayment.getById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Credit card payment not found'
      });
    }

    const deleted = await CreditCardPayment.delete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Credit card payment not found'
      });
    }

    try {
      await syncPaymentDeleted(existing);
    } catch (syncErr) {
      console.error('Statement sync failed after credit card payment delete:', syncErr);
      return res.json({
        success: true,
        message: 'Credit card payment deleted successfully, but statement sync failed',
        warning: syncErr.message || 'Failed to remove payment from card statement'
      });
    }

    res.json({
      success: true,
      message: 'Credit card payment deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting credit card payment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete credit card payment'
    });
  }
});

module.exports = router;



