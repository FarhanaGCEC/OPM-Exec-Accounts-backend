const path = require('path');
const express = require('express');
const PDC = require('../models/PDC');
const { authenticateToken, authenticateTokenOrQuery } = require('../middleware/auth');
const { requireElevatedForMutation } = require('../middleware/requireElevatedForMutation');
const { USER_ROLES } = require('../constants/roles');
const { queuePdcDelete, queuePdcUpdate } = require('../controllers/pdcChangeRequestQueue');

const { isGcecPdcType, isCustomerPdcType, parseDailyLedgerApproved } = require('../utils/pdcLedgerApproval');
const { formatAmount, roundToTwoDecimals } = require('../utils/formatAmount');
const {
  uploadPdcChequeImage,
  destroyPdcChequeImage,
  isCloudinaryConfigured
} = require('../services/cloudinaryPdcUpload');
const { pdcImageUploadMiddleware, optionalPdcImageMultipart } = require('../middleware/pdcAttachmentUpload');
const { buildPdcAttachmentPayload, normalizeMediaUrl } = require('../utils/attachmentPayload');

const MAX_PDC_IMAGE_BYTES = 15 * 1024 * 1024;
// Accepts cheque scans (images) and signed cheque copies (PDFs).
const PDC_IMAGE_FILENAME_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.pdf'
]);

const router = express.Router();

function formatTimestampForDisplay(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

function formatPdcForApi(pdc) {
  if (!pdc) return pdc;
  const attachment = buildPdcAttachmentPayload(pdc);
  const {
    attachment_name,
    attachment_url,
    attachment_cloudinary_public_id,
    attachment_resource_type,
    daily_ledger_approved,
    daily_ledger_approved_at,
    ...rest
  } = pdc;
  const approvalType = isGcecPdcType(pdc.pdc_type) || isCustomerPdcType(pdc.pdc_type);
  const ledgerOk = approvalType ? parseDailyLedgerApproved(daily_ledger_approved) : true;
  const out = {
    ...rest,
    amount: formatAmount(pdc.amount),
    attachment,
    dailyLedgerApproved: ledgerOk,
    dailyLedgerApprovedAt: daily_ledger_approved_at || null,
    dailyLedgerApprovedAtDisplay: formatTimestampForDisplay(daily_ledger_approved_at),
    pendingGcecLedgerApproval: approvalType && !ledgerOk
  };
  if (out.days_remaining !== undefined) {
    out.days_remaining = parseInt(out.days_remaining, 10) || 0;
  }
  return out;
}

/** Accept camelCase (API) or snake_case (mirrors DB / some clients) */
function normalizePdcInput(body = {}) {
  const customerName =
    body.customerName ??
    body.customer_name ??
    body.customer ??
    body.payee ??
    body.payeeName ??
    body.payee_name ??
    body.partyName ??
    body.party_name;
  return {
    chequeDate: body.chequeDate ?? body.cheque_date,
    chequeNumber: body.chequeNumber ?? body.cheque_number,
    customerName,
    amount: body.amount,
    chequeType: body.chequeType ?? body.cheque_type,
    pdcType: body.pdcType ?? body.pdc_type,
    description: body.description ?? body.description_text
  };
}

function isMissingPdcRequired(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return false;
}

function collectMissingPdcFields({ chequeDate, chequeNumber, customerName, amount, chequeType, pdcType }) {
  const missing = [];
  if (isMissingPdcRequired(chequeDate)) missing.push('chequeDate');
  if (isMissingPdcRequired(chequeNumber)) missing.push('chequeNumber');
  if (isMissingPdcRequired(customerName)) missing.push('customerName');
  if (amount === undefined || amount === null || amount === '') missing.push('amount');
  if (isMissingPdcRequired(chequeType)) missing.push('chequeType');
  if (isMissingPdcRequired(pdcType)) missing.push('pdcType');
  return missing;
}

/** Explains common "works locally, fails in prod" multipart issues (empty req.body, wrong Content-Type). */
function pdcMultipartValidationHint(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('multipart/form-data')) return undefined;
  if (!ct.includes('boundary=')) {
    return 'Multipart is missing boundary in Content-Type. Do not set Content-Type manually on FormData requests—let the browser set multipart/form-data with boundary=.... Manual multipart/form-data without boundary yields an empty body on the server.';
  }
  const keys = Object.keys(req.body || {});
  if (keys.length === 0) {
    return 'Multipart boundary looks valid but no fields were parsed (empty body). Common causes: reverse-proxy / serverless eating the raw body before Multer, or an API client stripping form fields. Try POST with Content-Type: application/json (no file) to confirm, or adjust hosting (e.g. disable default body parsing for this route).';
  }
  return undefined;
}

/**
 * Optional attachment with JSON body (avoids multipart when proxies/serverless break FormData).
 * Body: attachmentBase64 / attachment_base64 (+ optional attachmentFilename / attachment_filename).
 * Accepts raw base64 or data URL data:image/...;base64,... or data:application/pdf;base64,...
 * Returns { buffer, originalName, mimetype } | null (no attachment) | { error }
 */
function decodePdcImageBase64FromBody(body = {}) {
  const raw =
    body.attachmentBase64 ?? body.attachment_base64 ?? body.chequeImageBase64 ?? body.cheque_image_base64;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null;
  }
  const originalName = String(
    body.attachmentFilename ??
      body.attachment_filename ??
      body.chequeImageName ??
      body.cheque_image_name ??
      'cheque.jpg'
  )
    .trim()
    .slice(0, 512);

  let b64 = String(raw).trim();
  let mimetypeFromDataUrl = null;
  const dataUrl = b64.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUrl) {
    mimetypeFromDataUrl = dataUrl[1].toLowerCase();
    b64 = dataUrl[2];
  }
  b64 = b64.replace(/\s/g, '');

  let buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch {
    return { error: 'Invalid attachmentBase64: could not decode' };
  }
  if (!buffer.length) {
    return { error: 'attachmentBase64 decoded to empty data' };
  }
  if (buffer.length > MAX_PDC_IMAGE_BYTES) {
    return { error: `Cheque attachment exceeds maximum size (${MAX_PDC_IMAGE_BYTES} bytes)` };
  }
  const ext = path.extname(originalName).toLowerCase();
  if (ext && !PDC_IMAGE_FILENAME_EXT.has(ext)) {
    return {
      error: `Unsupported attachment filename extension (allowed: ${[...PDC_IMAGE_FILENAME_EXT].join(', ')})`
    };
  }
  if (
    mimetypeFromDataUrl &&
    !mimetypeFromDataUrl.startsWith('image/') &&
    mimetypeFromDataUrl !== 'application/pdf'
  ) {
    return {
      error: 'Unsupported attachmentBase64 MIME type (only image/* or application/pdf are allowed)'
    };
  }
  return { buffer, originalName, mimetype: mimetypeFromDataUrl || null };
}

async function savePdcAttachmentBuffer(
  pdcId,
  buffer,
  originalName,
  prevCloudinary = null,
  mimetype = null
) {
  if (!buffer || buffer.length === 0) {
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
  const name = (originalName || 'cheque.jpg').slice(0, 512);
  let uploaded;
  try {
    uploaded = await uploadPdcChequeImage({
      buffer,
      pdcId,
      originalFilename: name,
      mimetype
    });
  } catch (e) {
    console.error('Cloudinary PDC upload error:', e);
    return {
      ok: false,
      status: 502,
      error: e.message || 'Failed to upload cheque attachment to Cloudinary'
    };
  }
  await PDC.setChequeAttachment(pdcId, {
    attachmentName: name,
    attachmentUrl: uploaded.secure_url,
    attachmentCloudinaryPublicId: uploaded.public_id,
    attachmentResourceType: uploaded.resource_type || 'image'
  });
  const prev = normalizePrevCloudinary(prevCloudinary);
  if (prev.publicId && prev.publicId !== uploaded.public_id) {
    await destroyPdcChequeImage(prev.publicId, prev.resourceType);
  }
  return { ok: true };
}

function normalizePrevCloudinary(prev) {
  if (!prev) return { publicId: null, resourceType: 'image' };
  if (typeof prev === 'string') return { publicId: prev, resourceType: 'image' };
  return {
    publicId: prev.publicId || null,
    resourceType: prev.resourceType || 'image'
  };
}

async function finalizePdcAttachment(req, pdcId, prevCloudinary = null) {
  if (!req.file) {
    return { ok: true };
  }
  return savePdcAttachmentBuffer(
    pdcId,
    req.file.buffer,
    req.file.originalname,
    prevCloudinary,
    req.file.mimetype
  );
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

// Cheque attachment on Cloudinary — multipart field `attachment`
// Accepts images (JPEG, PNG, WebP, GIF, HEIC) and PDF documents.
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
          error: 'Missing attachment: send multipart field "attachment" (image or PDF)'
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
      const prevResourceType = existing.attachment_resource_type || 'image';
      const originalName = (req.file.originalname || 'cheque.jpg').slice(0, 512);

      let uploaded;
      try {
        uploaded = await uploadPdcChequeImage({
          buffer: req.file.buffer,
          pdcId,
          originalFilename: originalName,
          mimetype: req.file.mimetype
        });
      } catch (cloudErr) {
        console.error('Cloudinary PDC upload error:', cloudErr);
        return res.status(502).json({
          success: false,
          error: cloudErr.message || 'Failed to upload cheque attachment to Cloudinary'
        });
      }

      await PDC.setChequeAttachment(pdcId, {
        attachmentName: originalName,
        attachmentUrl: uploaded.secure_url,
        attachmentCloudinaryPublicId: uploaded.public_id,
        attachmentResourceType: uploaded.resource_type || 'image'
      });

      if (prevCloudinaryId && prevCloudinaryId !== uploaded.public_id) {
        await destroyPdcChequeImage(prevCloudinaryId, prevResourceType);
      }

      const pdc = await PDC.getById(pdcId);
      res.json({
        success: true,
        message: 'Cheque attachment saved',
        data: formatPdcForApi(pdc)
      });
    } catch (error) {
      console.error('Error attaching PDC attachment:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to attach cheque attachment'
      });
    }
  }
);

/**
 * Approve matured GCEC/Customer PDC on the daily ledger.
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
      if (!isGcecPdcType(existing.pdc_type) && !isCustomerPdcType(existing.pdc_type)) {
        return res.status(400).json({
          success: false,
          error: 'Daily ledger approval applies only to GCEC PDC and Customer PDC'
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

// Serve the cheque attachment.
// - Images: redirect to the public Cloudinary URL (cheap, cacheable).
// - PDFs (resource_type=raw): stream through this backend using a signed
//   Cloudinary download URL. This bypasses the "PDF and ZIP files delivery"
//   security toggle that otherwise causes 401s on /raw/upload/*.pdf URLs.
// Accepts auth via Authorization header OR `?token=...` query string so
// that <iframe>/<img>/<embed> tags can load it directly.
router.get('/:id/attachment', authenticateTokenOrQuery, async (req, res) => {
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

    const mediaUrl = normalizeMediaUrl(pdc.attachment_url);
    if (!mediaUrl) {
      return res.status(404).json({
        success: false,
        error: 'No cheque attachment available'
      });
    }

    const resourceType = pdc.attachment_resource_type || 'image';
    const isPdf = resourceType === 'raw' || /\.pdf($|\?)/i.test(pdc.attachment_name || pdc.attachment_url);

    if (!isPdf) {
      return res.redirect(302, mediaUrl);
    }

    if (!isCloudinaryConfigured() || !pdc.attachment_cloudinary_public_id) {
      return res.redirect(302, mediaUrl);
    }

    let signedUrl;
    try {
      const { cloudinary } = require('../config/cloudinary');
      // For raw resources the file extension is already part of the stored
      // public_id (e.g. "gcec-pdc-cheques/30/foo.pdf"), so we pass an empty
      // format here to avoid Cloudinary treating it as ".pdf.pdf".
      signedUrl = cloudinary.utils.private_download_url(
        pdc.attachment_cloudinary_public_id,
        '',
        {
          resource_type: 'raw',
          type: 'upload',
          expires_at: Math.floor(Date.now() / 1000) + 600
        }
      );
    } catch (e) {
      console.error('Cloudinary private_download_url error:', e);
      return res.status(502).json({
        success: false,
        error: 'Failed to sign Cloudinary download URL'
      });
    }

    let upstream;
    try {
      upstream = await fetch(signedUrl);
    } catch (e) {
      console.error('PDC PDF fetch error:', e);
      return res.status(502).json({
        success: false,
        error: 'Failed to retrieve PDC attachment from Cloudinary'
      });
    }
    if (!upstream.ok) {
      const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
      return res.status(status).json({
        success: false,
        error: `Cloudinary returned ${upstream.status} fetching attachment`
      });
    }

    const filename = (pdc.attachment_name || `cheque-${pdc.id}.pdf`).replace(/"/g, '');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/pdf');
    const upstreamLen = upstream.headers.get('content-length');
    if (upstreamLen) res.setHeader('Content-Length', upstreamLen);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');

    if (!upstream.body) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.end(buf);
    }
    const reader = upstream.body.getReader();
    res.on('close', () => { try { reader.cancel(); } catch (_) {} });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((r) => res.once('drain', r));
      }
    }
    res.end();
  } catch (error) {
    console.error('Error resolving PDC attachment:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Failed to resolve attachment'
      });
    } else {
      try { res.end(); } catch (_) {}
    }
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

// Create a new PDC: multipart (`attachment` file) OR JSON fields + optional `attachmentBase64` / `attachment_base64` (+ optional filename fields) when multipart is broken on a proxy.
// Parse multipart before auth so the request stream is consumed immediately (avoids empty req.body on some proxies when auth defers next()).
router.post('/', optionalPdcImageMultipart, authenticateToken, async (req, res) => {
  try {
    const { chequeDate, chequeNumber, customerName, amount, chequeType, pdcType, description } = normalizePdcInput(
      req.body
    );

    const missing = collectMissingPdcFields({
      chequeDate,
      chequeNumber,
      customerName,
      amount,
      chequeType,
      pdcType
    });
    if (missing.length > 0) {
      const hint = pdcMultipartValidationHint(req);
      return res.status(400).json({
        success: false,
        error: 'Cheque date, cheque number, customer name, amount, cheque type, and PDC type are required',
        missingFields: missing,
        ...(hint && { hint }),
        // Safe minimal debug for live: confirms whether Multer populated fields
        receivedBodyFieldCount: Object.keys(req.body || {}).length
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

    const decodedImage = decodePdcImageBase64FromBody(req.body);
    if (decodedImage && decodedImage.error) {
      return res.status(400).json({
        success: false,
        error: decodedImage.error
      });
    }
    if (req.file && decodedImage && decodedImage.buffer) {
      return res.status(400).json({
        success: false,
        error: 'Send either multipart field "attachment" or JSON attachmentBase64, not both'
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

    let attachResult;
    if (req.file) {
      attachResult = await finalizePdcAttachment(req, pdc.id, null);
    } else if (decodedImage && decodedImage.buffer) {
      attachResult = await savePdcAttachmentBuffer(
        pdc.id,
        decodedImage.buffer,
        decodedImage.originalName,
        null,
        decodedImage.mimetype || null
      );
    } else {
      attachResult = { ok: true };
    }
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

    const decodedImage = decodePdcImageBase64FromBody(req.body);
    if (decodedImage && decodedImage.error) {
      return res.status(400).json({
        success: false,
        error: decodedImage.error
      });
    }
    if (req.file && decodedImage && decodedImage.buffer) {
      return res.status(400).json({
        success: false,
        error: 'Send either multipart field "attachment" or JSON attachmentBase64, not both'
      });
    }

    let prevCloudinary = null;
    if (req.file || (decodedImage && decodedImage.buffer)) {
      const existingForAttach = await PDC.getById(id);
      if (!existingForAttach) {
        return res.status(404).json({
          success: false,
          error: 'Post-dated cheque not found'
        });
      }
      if (existingForAttach.attachment_cloudinary_public_id) {
        prevCloudinary = {
          publicId: existingForAttach.attachment_cloudinary_public_id,
          resourceType: existingForAttach.attachment_resource_type || 'image'
        };
      }
    }

    const { chequeDate, chequeNumber, customerName, amount, chequeType, pdcType, description } = normalizePdcInput(
      req.body
    );

    const missingUpdate = collectMissingPdcFields({
      chequeDate,
      chequeNumber,
      customerName,
      amount,
      chequeType,
      pdcType
    });
    if (missingUpdate.length > 0) {
      const hint = pdcMultipartValidationHint(req);
      return res.status(400).json({
        success: false,
        error: 'Cheque date, cheque number, customer name, amount, cheque type, and PDC type are required',
        missingFields: missingUpdate,
        ...(hint && { hint }),
        receivedBodyFieldCount: Object.keys(req.body || {}).length
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

    let attachResult;
    if (req.file) {
      attachResult = await finalizePdcAttachment(req, id, prevCloudinary);
    } else if (decodedImage && decodedImage.buffer) {
      attachResult = await savePdcAttachmentBuffer(
        id,
        decodedImage.buffer,
        decodedImage.originalName,
        prevCloudinary,
        decodedImage.mimetype || null
      );
    } else {
      attachResult = { ok: true };
    }
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
router.put(
  '/:id',
  optionalPdcImageMultipart,
  authenticateToken,
  (req, res, next) => {
    if (req.user && req.user.role === USER_ROLES.USER) {
      return queuePdcUpdate(req, res);
    }
    next();
  },
  requireElevatedForMutation,
  updatePdcHandler
);
router.patch(
  '/:id',
  optionalPdcImageMultipart,
  authenticateToken,
  (req, res, next) => {
    if (req.user && req.user.role === USER_ROLES.USER) {
      return queuePdcUpdate(req, res);
    }
    next();
  },
  requireElevatedForMutation,
  updatePdcHandler
);

// Delete a PDC
router.delete(
  '/:id',
  authenticateToken,
  (req, res, next) => {
    if (req.user && req.user.role === USER_ROLES.USER) {
      return queuePdcDelete(req, res);
    }
    next();
  },
  requireElevatedForMutation,
  async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await PDC.getById(id);
    if (existing?.attachment_cloudinary_public_id) {
      await destroyPdcChequeImage(
        existing.attachment_cloudinary_public_id,
        existing.attachment_resource_type || 'image'
      );
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

