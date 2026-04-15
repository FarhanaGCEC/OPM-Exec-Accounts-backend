const multer = require('multer');

const uploadBankLedgerCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    if (!name.endsWith('.csv')) {
      return cb(
        new Error('Only .csv files are allowed (in Excel: Save As → CSV UTF-8)')
      );
    }
    cb(null, true);
  }
});

module.exports = { uploadBankLedgerCsv };
