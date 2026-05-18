const path = require('path');
const { Readable } = require('stream');
const { cloudinary, isCloudinaryConfigured } = require('../config/cloudinary');

function sanitizePublicIdPart(name) {
  const base = path.basename(name || 'cheque', path.extname(name || ''));
  const cleaned = base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return cleaned || 'cheque';
}

function resolveResourceType({ mimetype, originalFilename }) {
  const mime = String(mimetype || '').toLowerCase();
  const ext = path.extname(originalFilename || '').toLowerCase();
  if (mime === 'application/pdf' || ext === '.pdf') return 'raw';
  return 'image';
}

function uploadTransactionChequeImage({ buffer, transactionId, originalFilename, mimetype }) {
  const prefix = (process.env.CLOUDINARY_TRANSACTION_FOLDER || 'gcec-transaction-cheques').replace(
    /^\/+|\/+$/g,
    ''
  );
  const resourceType = resolveResourceType({ mimetype, originalFilename });
  const ext = path.extname(originalFilename || '').toLowerCase();
  const publicIdBase = `${prefix}/${transactionId}/${Date.now()}_${sanitizePublicIdPart(originalFilename)}`;
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

async function destroyTransactionChequeImage(publicId, resourceType = 'image') {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType || 'image',
      invalidate: true
    });
  } catch (e) {
    console.error('Cloudinary transaction cheque destroy failed:', e.message || e);
  }
}

module.exports = {
  uploadTransactionChequeImage,
  destroyTransactionChequeImage,
  isCloudinaryConfigured
};
