const path = require('path');
const { Readable } = require('stream');
const { cloudinary, isCloudinaryConfigured } = require('../config/cloudinary');

function sanitizePublicIdPart(name) {
  const base = path.basename(name || 'cheque', path.extname(name || ''));
  const cleaned = base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return cleaned || 'cheque';
}

/**
 * Pick the right Cloudinary resource_type for the file.
 * - PDFs go to 'raw' (works on free + paid plans without PDF delivery toggle).
 * - Everything else (image/*) goes to 'image'.
 */
function resolveResourceType({ mimetype, originalFilename }) {
  const mime = String(mimetype || '').toLowerCase();
  const ext = path.extname(originalFilename || '').toLowerCase();
  if (mime === 'application/pdf' || ext === '.pdf') return 'raw';
  return 'image';
}

/**
 * Upload PDC cheque attachment (image OR pdf) to Cloudinary.
 * Returns { secure_url, public_id, resource_type }.
 */
function uploadPdcChequeImage({ buffer, pdcId, originalFilename, mimetype }) {
  const prefix = (process.env.CLOUDINARY_PDC_FOLDER || 'gcec-pdc-cheques').replace(/^\/+|\/+$/g, '');
  const resourceType = resolveResourceType({ mimetype, originalFilename });
  // For raw uploads Cloudinary keeps the extension as part of the public_id, so we
  // include it explicitly. For images Cloudinary appends its own extension on delivery.
  const ext = path.extname(originalFilename || '').toLowerCase();
  const publicIdBase = `${prefix}/${pdcId}/${Date.now()}_${sanitizePublicIdPart(originalFilename)}`;
  const publicId = resourceType === 'raw' && ext ? `${publicIdBase}${ext}` : publicIdBase;

  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: resourceType
      },
      (error, result) => {
        if (error) reject(error);
        else {
          resolve({
            secure_url: result.secure_url,
            public_id: result.public_id,
            resource_type: result.resource_type || resourceType
          });
        }
      }
    );
    Readable.from(buffer).pipe(upload);
  });
}

async function destroyPdcChequeImage(publicId, resourceType = 'image') {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType || 'image',
      invalidate: true
    });
  } catch (e) {
    console.error('Cloudinary PDC asset destroy failed:', e.message || e);
  }
}

module.exports = {
  uploadPdcChequeImage,
  destroyPdcChequeImage,
  resolvePdcResourceType: resolveResourceType,
  isCloudinaryConfigured
};
