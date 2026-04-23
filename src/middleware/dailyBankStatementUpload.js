const path = require('path');
const multer = require('multer');

const storage = multer.memoryStorage();

function pdfFileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mimeOk = file.mimetype === 'application/pdf';
  const extOk = ext === '.pdf';
  if (mimeOk || extOk) return cb(null, true);
  cb(new Error('Only PDF files are allowed'));
}

const uploadDailyBankStatementPdf = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: pdfFileFilter
});

function dailyBankStatementUploadMiddleware(req, res, next) {
  uploadDailyBankStatementPdf.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.message || 'Upload failed';
      return res.status(400).json({ success: false, error: msg });
    }
    next();
  });
}

module.exports = {
  uploadDailyBankStatementPdf,
  dailyBankStatementUploadMiddleware
};
