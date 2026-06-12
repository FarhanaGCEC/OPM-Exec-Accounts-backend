const path = require('path');
const { Readable } = require('stream');
const { cloudinary, isCloudinaryConfigured } = require('../config/cloudinary');

function sanitizePublicIdPart(name) {
  const base = path.basename(name || 'statement', path.extname(name || ''));
  const cleaned = base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return cleaned || 'statement';
}

function statementsFolderPrefix() {
  return (process.env.CLOUDINARY_STATEMENTS_FOLDER || 'gcec-card-statements').replace(/^\/+|\/+$/g, '');
}

/**
 * Upload statement attachment (PDF raw or image) to Cloudinary.
 */
function uploadStatementAttachment({
  buffer,
  pathSegment,
  originalFilename,
  resourceType = 'raw',
}) {
  const prefix = statementsFolderPrefix();
  const publicId = `${prefix}/${pathSegment}/${Date.now()}_${sanitizePublicIdPart(originalFilename)}`;

  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: resourceType === 'image' ? 'image' : 'raw',
      },
      (error, result) => {
        if (error) reject(error);
        else {
          resolve({
            secure_url: result.secure_url,
            public_id: result.public_id,
            resource_type: result.resource_type,
          });
        }
      }
    );
    Readable.from(buffer).pipe(upload);
  });
}

/** @deprecated use uploadStatementAttachment */
function uploadStatementPdf({ buffer, statementId, originalFilename }) {
  return uploadStatementAttachment({
    buffer,
    pathSegment: String(statementId),
    originalFilename,
    resourceType: 'raw',
  });
}

async function destroyStatementAttachment(publicId, resourceType = 'raw') {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType === 'image' ? 'image' : 'raw',
      invalidate: true,
    });
  } catch (e) {
    console.error('Cloudinary destroy failed:', e.message || e);
  }
}

/** Remove a statement attachment from Cloudinary (images use resource_type image, PDFs use raw). */
async function destroyStatementAttachmentFully(publicId, { name, url } = {}) {
  if (!publicId) return;
  const { inferCloudinaryResourceType } = require('../utils/cloudinaryAttachmentStream');
  const primary = inferCloudinaryResourceType({ name, url });
  await destroyStatementAttachment(publicId, primary);
  const secondary = primary === 'image' ? 'raw' : 'image';
  await destroyStatementAttachment(publicId, secondary);
}

/** @deprecated use destroyStatementAttachmentFully or destroyStatementAttachment */
async function destroyStatementPdf(publicId) {
  return destroyStatementAttachmentFully(publicId);
}

module.exports = {
  uploadStatementAttachment,
  uploadStatementPdf,
  destroyStatementAttachment,
  destroyStatementAttachmentFully,
  destroyStatementPdf,
  isCloudinaryConfigured,
};
