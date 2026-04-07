const path = require('path');
const { Readable } = require('stream');
const { cloudinary, isCloudinaryConfigured } = require('../config/cloudinary');

function sanitizePublicIdPart(name) {
  const base = path.basename(name || 'cheque', path.extname(name || ''));
  const cleaned = base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return cleaned || 'cheque';
}

/**
 * Upload cheque image buffer to Cloudinary (image). Returns secure_url and public_id.
 */
function uploadPdcChequeImage({ buffer, pdcId, originalFilename }) {
  const prefix = (process.env.CLOUDINARY_PDC_FOLDER || 'gcec-pdc-cheques').replace(/^\/+|\/+$/g, '');
  const publicId = `${prefix}/${pdcId}/${Date.now()}_${sanitizePublicIdPart(originalFilename)}`;

  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: 'image'
      },
      (error, result) => {
        if (error) reject(error);
        else {
          resolve({
            secure_url: result.secure_url,
            public_id: result.public_id
          });
        }
      }
    );
    Readable.from(buffer).pipe(upload);
  });
}

async function destroyPdcChequeImage(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image',
      invalidate: true
    });
  } catch (e) {
    console.error('Cloudinary PDC image destroy failed:', e.message || e);
  }
}

module.exports = {
  uploadPdcChequeImage,
  destroyPdcChequeImage,
  isCloudinaryConfigured
};
