const path = require('path');
const { Readable } = require('stream');
const { cloudinary, isCloudinaryConfigured } = require('../config/cloudinary');

function sanitizePublicIdPart(name) {
  const base = path.basename(name || 'statement', path.extname(name || ''));
  const cleaned = base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return cleaned || 'statement';
}

/**
 * Upload PDF buffer to Cloudinary as raw file. Returns secure_url and public_id.
 */
function uploadStatementPdf({ buffer, statementId, originalFilename }) {
  const prefix = (process.env.CLOUDINARY_STATEMENTS_FOLDER || 'gcec-card-statements').replace(/^\/+|\/+$/g, '');
  const publicId = `${prefix}/${statementId}/${Date.now()}_${sanitizePublicIdPart(originalFilename)}`;

  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: 'raw'
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

async function destroyStatementPdf(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: 'raw',
      invalidate: true
    });
  } catch (e) {
    console.error('Cloudinary destroy failed:', e.message || e);
  }
}

module.exports = {
  uploadStatementPdf,
  destroyStatementPdf,
  isCloudinaryConfigured
};
