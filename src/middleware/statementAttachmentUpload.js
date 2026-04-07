const path = require('path');
const multer = require('multer');

/** In-memory PDF for Cloudinary upload (no disk) */
const storage = multer.memoryStorage();

function pdfFileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mimeOk = file.mimetype === 'application/pdf';
  const extOk = ext === '.pdf';
  if (mimeOk || extOk) return cb(null, true);
  cb(new Error('Only PDF files are allowed'));
}

const uploadStatementPdf = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: pdfFileFilter
});

/** Multer wrapper: single field name `attachment` */
function statementPdfUploadMiddleware(req, res, next) {
  uploadStatementPdf.single('attachment')(req, res, (err) => {
    if (err) {
      const msg = err.message || 'Upload failed';
      return res.status(400).json({ success: false, error: msg });
    }
    next();
  });
}

/** Parse multipart PDF fields + optional `attachment`; skip when not multipart (JSON body unchanged). */
function optionalStatementPdfMultipart(req, res, next) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('multipart/form-data')) {
    return next();
  }
  uploadStatementPdf.single('attachment')(req, res, (err) => {
    if (err) {
      const msg = err.message || 'Upload failed';
      return res.status(400).json({ success: false, error: msg });
    }
    next();
  });
}

module.exports = {
  uploadStatementPdf,
  statementPdfUploadMiddleware,
  optionalStatementPdfMultipart
};
