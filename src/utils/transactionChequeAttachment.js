const path = require('path');
const Transaction = require('../models/Transaction');
const {
  uploadTransactionChequeImage,
  destroyTransactionChequeImage,
  isCloudinaryConfigured
} = require('../services/cloudinaryTransactionUpload');
const { payloadWantsRemoveAttachment } = require('./chequeAttachmentRemove');

const MAX_CHEQUE_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const CHEQUE_FILENAME_EXT = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
  '.pdf'
]);

function normalizePrevCloudinary(prev) {
  if (!prev) return { publicId: null, resourceType: 'image' };
  if (typeof prev === 'string') return { publicId: prev, resourceType: 'image' };
  return {
    publicId: prev.publicId || null,
    resourceType: prev.resourceType || 'image'
  };
}

function decodeChequeAttachmentBase64FromBody(body = {}) {
  const raw =
    body.attachmentBase64 ??
    body.attachment_base64 ??
    body.chequeImageBase64 ??
    body.cheque_image_base64;
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
  if (buffer.length > MAX_CHEQUE_ATTACHMENT_BYTES) {
    return {
      error: `Cheque attachment exceeds maximum size (${MAX_CHEQUE_ATTACHMENT_BYTES} bytes)`
    };
  }
  const ext = path.extname(originalName).toLowerCase();
  if (ext && !CHEQUE_FILENAME_EXT.has(ext)) {
    return {
      error: `Unsupported attachment filename extension (allowed: ${[...CHEQUE_FILENAME_EXT].join(', ')})`
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

async function saveTransactionChequeAttachmentBuffer(
  transactionId,
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
    uploaded = await uploadTransactionChequeImage({
      buffer,
      transactionId,
      originalFilename: name,
      mimetype
    });
  } catch (e) {
    console.error('Cloudinary transaction cheque upload error:', e);
    return {
      ok: false,
      status: 502,
      error: e.message || 'Failed to upload cheque attachment to Cloudinary'
    };
  }
  await Transaction.setChequeAttachment(transactionId, {
    attachmentName: name,
    attachmentUrl: uploaded.secure_url,
    attachmentCloudinaryPublicId: uploaded.public_id,
    attachmentResourceType: uploaded.resource_type || 'image'
  });
  const prev = normalizePrevCloudinary(prevCloudinary);
  if (prev.publicId && prev.publicId !== uploaded.public_id) {
    await destroyTransactionChequeImage(prev.publicId, prev.resourceType);
  }
  return { ok: true };
}

async function clearTransactionChequeAttachment(transactionId, prevRow) {
  if (prevRow && prevRow.attachment_cloudinary_public_id) {
    await destroyTransactionChequeImage(
      prevRow.attachment_cloudinary_public_id,
      prevRow.attachment_resource_type || 'image'
    );
  }
  await Transaction.clearChequeAttachment(transactionId);
  return { ok: true };
}

/**
 * Apply remove / multipart file / JSON base64 cheque attachment when paymentType is cheque.
 */
async function applyTransactionChequeAttachmentFromRequest(req, transactionId, paymentType, prevRow) {
  const pt = String(paymentType || '').toLowerCase();
  const body = req.body || {};
  const wantsRemove = payloadWantsRemoveAttachment(body);
  const hasFile = Boolean(req.file && req.file.buffer && req.file.buffer.length);
  const decoded = decodeChequeAttachmentBase64FromBody(body);
  if (decoded && decoded.error) {
    return { ok: false, status: 400, error: decoded.error };
  }
  const hasBase64 = Boolean(decoded && decoded.buffer);

  if (pt !== 'cheque') {
    if (hasFile || hasBase64) {
      return {
        ok: false,
        status: 400,
        error: 'Cheque image/PDF is only allowed when paymentType is cheque'
      };
    }
    if (wantsRemove && prevRow && prevRow.attachment_url) {
      return clearTransactionChequeAttachment(transactionId, prevRow);
    }
    return { ok: true };
  }

  if (wantsRemove && (hasFile || hasBase64)) {
    return {
      ok: false,
      status: 400,
      error: 'Send either removeAttachment: true or a new attachment file, not both'
    };
  }

  if (wantsRemove) {
    return clearTransactionChequeAttachment(transactionId, prevRow);
  }

  if (hasFile && hasBase64) {
    return {
      ok: false,
      status: 400,
      error: 'Send either multipart field "attachment" or JSON attachmentBase64, not both'
    };
  }

  if (!hasFile && !hasBase64) {
    return { ok: true };
  }

  const prevCloudinary =
    prevRow && prevRow.attachment_cloudinary_public_id
      ? {
          publicId: prevRow.attachment_cloudinary_public_id,
          resourceType: prevRow.attachment_resource_type || 'image'
        }
      : null;

  if (hasFile) {
    return saveTransactionChequeAttachmentBuffer(
      transactionId,
      req.file.buffer,
      req.file.originalname,
      prevCloudinary,
      req.file.mimetype
    );
  }

  return saveTransactionChequeAttachmentBuffer(
    transactionId,
    decoded.buffer,
    decoded.originalName,
    prevCloudinary,
    decoded.mimetype
  );
}

module.exports = {
  MAX_CHEQUE_ATTACHMENT_BYTES,
  CHEQUE_FILENAME_EXT,
  decodeChequeAttachmentBase64FromBody,
  saveTransactionChequeAttachmentBuffer,
  clearTransactionChequeAttachment,
  applyTransactionChequeAttachmentFromRequest,
  normalizePrevCloudinary
};
