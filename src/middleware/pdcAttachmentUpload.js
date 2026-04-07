const path = require('path');
const multer = require('multer');

const storage = multer.memoryStorage();

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif'
]);

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif']);

function imageFileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ALLOWED_MIME.has(file.mimetype) || ALLOWED_EXT.has(ext)) {
    return cb(null, true);
  }
  cb(new Error('Only image files are allowed (JPEG, PNG, WebP, GIF, HEIC)'));
}

const uploadPdcImage = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: imageFileFilter
});

function pdcImageUploadMiddleware(req, res, next) {
  uploadPdcImage.single('attachment')(req, res, (err) => {
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
  uploadPdcImage.single('attachment')(req, res, (err) => {
    if (err) {
      const msg = err.message || 'Upload failed';
      return res.status(400).json({ success: false, error: msg });
    }
    next();
  });
}

module.exports = {
  uploadPdcImage,
  pdcImageUploadMiddleware,
  optionalPdcImageMultipart
};
