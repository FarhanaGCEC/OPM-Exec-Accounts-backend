const express = require('express');
const PDC = require('../models/PDC');
const { authenticateToken } = require('../middleware/auth');
const { requireElevatedForMutation } = require('../middleware/requireElevatedForMutation');

const { isGcecPdcType, parseDailyLedgerApproved } = require('../utils/pdcLedgerApproval');
const { formatAmount, roundToTwoDecimals } = require('../utils/formatAmount');
const {
  uploadPdcChequeImage,
  destroyPdcChequeImage,
  isCloudinaryConfigured
} = require('../services/cloudinaryPdcUpload');
const { pdcImageUploadMiddleware, optionalPdcImageMultipart } = require('../middleware/pdcAttachmentUpload');

const router = express.Router();

function formatPdcForApi(pdc) {
  if (!pdc) return pdc;
  const attachment = pdc.attachment_url
    ? { name: pdc.attachment_name || 'cheque-image', url: pdc.attachment_url }
    : null;
  const {
    attachment_name,
    attachment_url,
    attachment_cloudinary_public_id,
    daily_ledger_approved,
    ...rest
  } = pdc;
  const gcec = isGcecPdcType(pdc.pdc_type);
  const ledgerOk = gcec ? parseDailyLedgerApproved(daily_ledger_approved) : true;
  const out = {
    ...rest,
    amount: formatAmount(pdc.amount),
    attachment,
    dailyLedgerApproved: ledgerOk,
    pendingGcecLedgerApproval: gcec && !ledgerOk
  };
  if (out.days_remaining !== undefined) {
    out.days_remaining = parseInt(out.days_remaining, 10) || 0;
  }
  return out;
}

/** Accept camelCase (API) or snake_case (mirrors DB / some clients) */
function normalizePdcInput(body = {}) {
  return {
    chequeDate: body.chequeDate ?? body.cheque_date,
    chequeNumber: body.chequeNumber ?? body.cheque_number,
    customerName: body.customerName ?? body.customer_name,
    amount: body.amount,
    chequeType: body.chequeType ?? body.cheque_type,
    pdcType: body.pdcType ?? body.pdc_type,
    description: body.description
  };
}

async function finalizePdcAttachment(req, pdcId, prevCloudinaryPublicId = null) {
  if (!req.file) {
    return { ok: true };
  }
  if (!isCloudinaryConfigured()) {
    return {
      ok: false,
      status: 503,
      error:
        'Cloudinary is not configured. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.'
    };
  }
  const originalName = (req.file.originalname || 'cheque.jpg').slice(0, 512);
  let uploaded;
  try {
    uploaded = await uploadPdcChequeImage({
      buffer: req.file.buffer,
      pdcId,
      originalFilename: originalName
    });
  } catch (e) {
    console.error('Cloudinary PDC upload error:', e);
    return {
      ok: false,
      status: 502,
      error: e.message || 'Failed to upload cheque image to Cloudinary'
    };
  }
  await PDC.setChequeAttachment(pdcId, {
    attachmentName: originalName,
    attachmentUrl: uploaded.secure_url,
    attachmentCloudinaryPublicId: uploaded.public_id
  });
  if (prevCloudinaryPublicId && prevCloudinaryPublicId !== uploaded.public_id) {
    await destroyPdcChequeImage(prevCloudinaryPublicId);
  }
  return { ok: true };
}

// Get all post-dated cheques
router.get('/', authenticateToken, async (req, res) => {
  try {
    const pdcs = await PDC.getAll();
    res.json({
      success: true,
      data: pdcs.map((pdc) => formatPdcForApi(pdc))
    });
  } catch (error) {
    console.error('Error fetching PDCs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch post-dated cheques'
    });
  }
});

// Get PDCs near cheque date (for dashboard reminders)
router.get('/reminders', authenticateToken, async (req, res) => {
  try {
    // Get days parameter from query string (default: 30 days)
    const days = parseInt(req.query.days) || 30;
    
    // Validate days parameter
    if (isNaN(days) || days < 1 || days > 365) {
      return res.status(400).json({
        success: false,
        error: 'Days parameter must be a number between 1 and 365'
      });
    }

    const pdcs = await PDC.getNearChequeDate(days);
    
    // Debug: Also check what pdc_types actually exist in the database
    if (pdcs.length === 0 && req.query.debug === 'true') {
      const { pool } = require('../config/database');
      const allTypes = await pool.query(`
        SELECT DISTINCT pdc_type, COUNT(*) as count 
        FROM post_dated_cheques 
        GROUP BY pdc_type
      `);
      const allPDCs = await pool.query(`
        SELECT id, cheque_date, pdc_type, customer_name 
        FROM post_dated_cheques 
        ORDER BY cheque_date DESC 
        LIMIT 10
      `);
      
      return res.json({
        success: true,
        data: [],
        count: 0,
        days_lookahead: days,
        debug: {
          available_types: allTypes.rows,
          recent_pdcs: allPDCs.rows,
          message: 'No PDCs found. Check debug info above.'
        }
      });
    }
    
    res.json({
      success: true,
      data: pdcs.map((pdc) => formatPdcForApi(pdc)),
      count: pdcs.length,
      days_lookahead: days
    });
  } catch (error) {
    console.error('Error fetching PDC reminders:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch PDC reminders',
      details: error.message
    });
  }
});

// Cheque image on Cloudinary — multipart field `attachment` (JPEG, PNG, WebP, GIF, HEIC)
router.post(
  '/:id/attachment',
  authenticateToken,
  requireElevatedForMutation,
  pdcImageUploadMiddleware,
  async (req, res) => {
    try {
      if (!isCloudinaryConfigured()) {
        return res.status(503).json({
          success: false,
          error:
            'Cloudinary is not configured. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.'
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'Missing image: send multipart field "attachment"'
        });
      }

      const pdcId = parseInt(req.params.id, 10);
      if (Number.isNaN(pdcId)) {
        return res.status(400).json({ success: false, error: 'Invalid PDC id' });
      }

      const existing = await PDC.getById(pdcId);
      if (!existing) {
        return res.status(404).json({
          success: false,
          error: 'Post-dated cheque not found'
        });
      }

      const prevCloudinaryId = existing.attachment_cloudinary_public_id;
      const originalName = (req.file.originalname || 'cheque.jpg').slice(0, 512);

      let uploaded;
      try {
        uploaded = await uploadPdcChequeImage({
          buffer: req.file.buffer,
          pdcId,
          originalFilename: originalName
        });
      } catch (cloudErr) {
        console.error('Cloudinary PDC upload error:', cloudErr);
        return res.status(502).json({
          success: false,
          error: cloudErr.message || 'Failed to upload cheque image to Cloudinary'
        });
      }

      await PDC.setChequeAttachment(pdcId, {
        attachmentName: originalName,
        attachmentUrl: uploaded.secure_url,
        attachmentCloudinaryPublicId: uploaded.public_id
      });

      if (prevCloudinaryId && prevCloudinaryId !== uploaded.public_id) {
        await destroyPdcChequeImage(prevCloudinaryId);
      }

      const pdc = await PDC.getById(pdcId);
      res.json({
        success: true,
        message: 'Cheque image attached',
        data: formatPdcForApi(pdc)
      });
    } catch (error) {
      console.error('Error attaching PDC image:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to attach cheque image'
      });
    }
  }
);

/**
 * Approve matured GCEC PDC on the daily ledger (Customer & Custom PDC are auto-approved in the UI; only GCEC uses this).
 * Body: { "approved": true } or { "dailyLedgerApproved": true }
 */
router.patch(
  '/:id/daily-ledger-approved',
  authenticateToken,
  requireElevatedForMutation,
  async (req, res) => {
    try {
      const pdcId = parseInt(req.params.id, 10);
      if (!Number.isInteger(pdcId) || pdcId < 1) {
        return res.status(400).json({ success: false, error: 'Invalid PDC id' });
      }

      const raw =
        req.body.approved !== undefined
          ? req.body.approved
          : req.body.dailyLedgerApproved !== undefined
            ? req.body.dailyLedgerApproved
            : undefined;
      if (raw === undefined) {
        return res.status(400).json({
          success: false,
          error: 'Body must include approved or dailyLedgerApproved (boolean)'
        });
      }

      const approved = raw === true || raw === 1 || String(raw).toLowerCase() === 'true';
      const existing = await PDC.getById(pdcId);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Post-dated cheque not found' });
      }
      if (!isGcecPdcType(existing.pdc_type)) {
        return res.status(400).json({
          success: false,
          error: 'Daily ledger approval applies only to GCEC PDC (Customer PDC and Custom PDC are auto-approved)'
        });
      }

      const updated = await PDC.setDailyLedgerApproved(pdcId, approved);
      res.json({
        success: true,
        message: approved ? 'Daily ledger marked as approved' : 'Daily ledger approval cleared',
        data: formatPdcForApi(updated)
      });
    } catch (error) {
      console.error('Error updating daily ledger approval:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to update daily ledger approval'
      });
    }
  }
);

// Redirect to Cloudinary URL (same attachment as in list/detail)
router.get('/:id/attachment', authenticateToken, async (req, res) => {
  try {
    const pdcId = parseInt(req.params.id, 10);
    if (Number.isNaN(pdcId)) {
      return res.status(400).json({ success: false, error: 'Invalid PDC id' });
    }

    const pdc = await PDC.getById(pdcId);
    if (!pdc) {
      return res.status(404).json({
        success: false,
        error: 'Post-dated cheque not found'
      });
    }

    if (!pdc.attachment_url) {
      return res.status(404).json({
        success: false,
        error: 'No cheque image attached'
      });
    }

    res.redirect(302, pdc.attachment_url);
  } catch (error) {
    console.error('Error resolving PDC attachment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to resolve attachment'
    });
  }
});

// Get a single PDC by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const pdc = await PDC.getById(id);

    if (!pdc) {
      return res.status(404).json({
        success: false,
        error: 'Post-dated cheque not found'
      });
    }

    res.json({
      success: true,
      data: formatPdcForApi(pdc)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch post-dated cheque'
    });
  }
});

// Create a new PDC (JSON body, or multipart/form-data with same fields + optional file field `attachment`)
router.post('/', authenticateToken, optionalPdcImageMultipart, async (req, res) => {
  try {
    const { chequeDate, chequeNumber, customerName, amount, chequeType, pdcType, description } = normalizePdcInput(
      req.body
    );

    // Validation
    if (!chequeDate || !chequeNumber || !customerName || !amount || !chequeType || !pdcType) {
      return res.status(400).json({
        success: false,
        error: 'Cheque date, cheque number, customer name, amount, cheque type, and PDC type are required'
      });
    }

    // Validate cheque type
    const validChequeTypes = ['Payment Cheque', 'Security Cheque', 'Other'];
    if (!validChequeTypes.includes(chequeType)) {
      return res.status(400).json({
        success: false,
        error: `Cheque type must be one of: ${validChequeTypes.join(', ')}`
      });
    }

    // Validate PDC type
    const validPDCTypes = ['GCEC PDC', 'Customer PDC', 'Custom PDC'];
    if (!validPDCTypes.includes(pdcType)) {
      return res.status(400).json({
        success: false,
        error: `PDC type must be one of: ${validPDCTypes.join(', ')}`
      });
    }

    // If Custom PDC, description is required
    if (pdcType === 'Custom PDC' && (!description || description.trim() === '')) {
      return res.status(400).json({
        success: false,
        error: 'Description is required for Custom PDC'
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

    // Convert date format if needed (DD/MM/YYYY to YYYY-MM-DD)
    const dateStr = String(chequeDate);
    let formattedDate = dateStr;
    if (dateStr.includes('/')) {
      const [day, month, year] = dateStr.split('/');
      formattedDate = `${year}-${month}-${day}`;
    }

    // Get user ID from JWT token
    const createdBy = req.user ? req.user.id : null;

    const pdc = await PDC.create({
      chequeDate: formattedDate,
      chequeNumber: chequeNumber.trim(),
      customerName: customerName.trim(),
      amount: roundedAmount,
      chequeType: chequeType,
      pdcType: pdcType,
      description: description ? description.trim() : null,
      createdBy: createdBy
    });

    const attachResult = await finalizePdcAttachment(req, pdc.id, null);
    if (!attachResult.ok) {
      await PDC.delete(pdc.id);
      return res.status(attachResult.status).json({
        success: false,
        error: attachResult.error
      });
    }

    const full = await PDC.getById(pdc.id);
    res.status(201).json({
      success: true,
      message: 'Post-dated cheque created successfully',
      data: formatPdcForApi(full)
    });
  } catch (error) {
    console.error('Error creating PDC:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create post-dated cheque'
    });
  }
});

const updatePdcHandler = async (req, res) => {
  try {
    const { id } = req.params;
    let prevCloudinaryPublicId = null;
    if (req.file) {
      const existingForAttach = await PDC.getById(id);
      if (!existingForAttach) {
        return res.status(404).json({
          success: false,
          error: 'Post-dated cheque not found'
        });
      }
      prevCloudinaryPublicId = existingForAttach.attachment_cloudinary_public_id;
    }

    const { chequeDate, chequeNumber, customerName, amount, chequeType, pdcType, description } = normalizePdcInput(
      req.body
    );

    if (!chequeDate || !chequeNumber || !customerName || !amount || !chequeType || !pdcType) {
      return res.status(400).json({
        success: false,
        error: 'Cheque date, cheque number, customer name, amount, cheque type, and PDC type are required'
      });
    }

    const validChequeTypes = ['Payment Cheque', 'Security Cheque', 'Other'];
    if (!validChequeTypes.includes(chequeType)) {
      return res.status(400).json({
        success: false,
        error: `Cheque type must be one of: ${validChequeTypes.join(', ')}`
      });
    }

    const validPDCTypes = ['GCEC PDC', 'Customer PDC', 'Custom PDC'];
    if (!validPDCTypes.includes(pdcType)) {
      return res.status(400).json({
        success: false,
        error: `PDC type must be one of: ${validPDCTypes.join(', ')}`
      });
    }

    if (pdcType === 'Custom PDC' && (!description || description.trim() === '')) {
      return res.status(400).json({
        success: false,
        error: 'Description is required for Custom PDC'
      });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be greater than 0'
      });
    }

    const roundedAmount = roundToTwoDecimals(parsedAmount);

    const dateStr = String(chequeDate);
    let formattedDate = dateStr;
    if (dateStr.includes('/')) {
      const [day, month, year] = dateStr.split('/');
      formattedDate = `${year}-${month}-${day}`;
    }

    const pdc = await PDC.update(id, {
      chequeDate: formattedDate,
      chequeNumber: String(chequeNumber).trim(),
      customerName: String(customerName).trim(),
      amount: roundedAmount,
      chequeType: chequeType,
      pdcType: pdcType,
      description: description ? String(description).trim() : null
    });

    if (!pdc) {
      return res.status(404).json({
        success: false,
        error: 'Post-dated cheque not found'
      });
    }

    const attachResult = await finalizePdcAttachment(req, id, prevCloudinaryPublicId);
    if (!attachResult.ok) {
      return res.status(attachResult.status).json({
        success: false,
        error: attachResult.error
      });
    }

    const full = await PDC.getById(id);
    res.json({
      success: true,
      message: 'Post-dated cheque updated successfully',
      data: formatPdcForApi(full)
    });
  } catch (error) {
    console.error('Error updating PDC:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update post-dated cheque'
    });
  }
};

// Update a PDC (PUT or PATCH — JSON or multipart + optional `attachment`)
router.put('/:id', authenticateToken, requireElevatedForMutation, optionalPdcImageMultipart, updatePdcHandler);
router.patch(
  '/:id',
  authenticateToken,
  requireElevatedForMutation,
  optionalPdcImageMultipart,
  updatePdcHandler
);

// Delete a PDC
router.delete('/:id', authenticateToken, requireElevatedForMutation, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await PDC.getById(id);
    if (existing?.attachment_cloudinary_public_id) {
      await destroyPdcChequeImage(existing.attachment_cloudinary_public_id);
    }

    const deleted = await PDC.delete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Post-dated cheque not found'
      });
    }

    res.json({
      success: true,
      message: 'Post-dated cheque deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting PDC:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete post-dated cheque'
    });
  }
});

module.exports = router;

