const PDC = require('../models/PDC');
const {
  uploadPdcChequeImage,
  destroyPdcChequeImage,
  isCloudinaryConfigured
} = require('../services/cloudinaryPdcUpload');
const { payloadWantsRemoveAttachment } = require('./chequeAttachmentRemove');
const {
  decodeChequeAttachmentBase64FromBody,
  normalizePrevCloudinary
} = require('./transactionChequeAttachment');

async function clearPdcChequeAttachment(pdcId, existingRow) {
  const row = existingRow || (await PDC.getById(pdcId));
  if (!row) {
    return { ok: false, status: 404, error: 'Post-dated cheque not found' };
  }
  if (row.attachment_cloudinary_public_id) {
    await destroyPdcChequeImage(
      row.attachment_cloudinary_public_id,
      row.attachment_resource_type || 'image'
    );
  }
  await PDC.clearChequeAttachment(pdcId);
  return { ok: true };
}

async function savePdcChequeAttachmentBuffer(
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

async function applyPdcChequeAttachmentFromRequest(req, pdcId, existingPdc) {
  const body = req.body || {};
  const wantsRemove = payloadWantsRemoveAttachment(body);
  const hasFile = Boolean(req.file && req.file.buffer && req.file.buffer.length);
  const decoded = decodeChequeAttachmentBase64FromBody(body);
  if (decoded && decoded.error) {
    return { ok: false, status: 400, error: decoded.error };
  }
  const hasBase64 = Boolean(decoded && decoded.buffer);

  if (wantsRemove && (hasFile || hasBase64)) {
    return {
      ok: false,
      status: 400,
      error: 'Send either removeAttachment: true or a new attachment file, not both'
    };
  }

  if (wantsRemove) {
    return clearPdcChequeAttachment(pdcId, existingPdc);
  }

  if (!hasFile && !hasBase64) {
    return { ok: true };
  }

  const prevCloudinary =
    existingPdc && existingPdc.attachment_cloudinary_public_id
      ? {
          publicId: existingPdc.attachment_cloudinary_public_id,
          resourceType: existingPdc.attachment_resource_type || 'image'
        }
      : null;

  if (hasFile) {
    return savePdcChequeAttachmentBuffer(
      pdcId,
      req.file.buffer,
      req.file.originalname,
      prevCloudinary,
      req.file.mimetype
    );
  }

  return savePdcChequeAttachmentBuffer(
    pdcId,
    decoded.buffer,
    decoded.originalName,
    prevCloudinary,
    decoded.mimetype
  );
}

module.exports = {
  clearPdcChequeAttachment,
  savePdcChequeAttachmentBuffer,
  applyPdcChequeAttachmentFromRequest
};
