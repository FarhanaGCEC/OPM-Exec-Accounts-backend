const path = require('path');
const multer = require('multer');

const storage = multer.memoryStorage();

const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif'
]);

const ALLOWED_PDF_MIME = new Set(['application/pdf']);

const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif']);
const ALLOWED_PDF_EXT = new Set(['.pdf']);

const ALLOWED_MIME = new Set([...ALLOWED_IMAGE_MIME, ...ALLOWED_PDF_MIME]);
const ALLOWED_EXT = new Set([...ALLOWED_IMAGE_EXT, ...ALLOWED_PDF_EXT]);

function attachmentFileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ALLOWED_MIME.has(file.mimetype) || ALLOWED_EXT.has(ext)) {
    return cb(null, true);
  }
  cb(new Error('Only image (JPEG, PNG, WebP, GIF, HEIC) or PDF files are allowed'));
}

const uploadPdcAttachment = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: attachmentFileFilter
});

function pdcImageUploadMiddleware(req, res, next) {
  uploadPdcAttachment.single('attachment')(req, res, (err) => {
    if (err) {
      const msg = err.message || 'Upload failed';
      return res.status(400).json({ success: false, error: msg });
    }
    next();
  });
}

/** Parse multipart (fields + optional file `attachment`) only when client sends multipart/form-data */
function optionalPdcImageMultipart(req, res, next) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('multipart/form-data')) {
    return next();
  }
  uploadPdcAttachment.single('attachment')(req, res, (err) => {
    if (err) {
      const msg = err.message || 'Upload failed';
      return res.status(400).json({ success: false, error: msg });
    }
    next();
  });
}

module.exports = {
  uploadPdcAttachment,
  uploadPdcImage: uploadPdcAttachment,
  pdcImageUploadMiddleware,
  optionalPdcImageMultipart,
  ALLOWED_IMAGE_EXT,
  ALLOWED_PDF_EXT,
  ALLOWED_IMAGE_MIME,
  ALLOWED_PDF_MIME
};
