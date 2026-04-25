const express = require('express');
const fs = require('fs');
const path = require('path');
const { authenticateToken } = require('../middleware/auth');
const { monthlyBankStatementUploadMiddleware } = require('../middleware/monthlyBankStatementUpload');
const MonthlyBankStatement = require('../models/MonthlyBankStatement');

const router = express.Router();

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'monthly-bank-statements');
const VALID_CURRENCIES = new Set(['AED', 'USD', 'GBP']);
const VALID_FILE_TYPES = new Set(['bank_statement', 'monthly_invoice']);

function sanitizeFilename(name) {
  return String(name || 'document.pdf')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

function normalizeCurrency(value) {
  return String(value || '').toUpperCase().trim();
}

function normalizeMonth(value) {
  const month = String(value || '').trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : '';
}

async function removeFileIfExists(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to remove monthly bank statement file:', error.message);
    }
  }
}

function formatResponse(record) {
  if (!record) return null;
  return {
    id: record.id,
    month_period: record.month_period,
    currency: record.currency,
    bank_statement: {
      original_filename: record.bank_statement_original_filename,
      stored_filename: record.bank_statement_stored_filename,
      mime_type: record.bank_statement_mime_type,
      file_size: record.bank_statement_file_size,
      download_url: `/api/monthly-bank-statements/file/bank_statement?month=${record.month_period}&currency=${record.currency}`
    },
    monthly_invoice: {
      original_filename: record.monthly_invoice_original_filename,
      stored_filename: record.monthly_invoice_stored_filename,
      mime_type: record.monthly_invoice_mime_type,
      file_size: record.monthly_invoice_file_size,
      download_url: `/api/monthly-bank-statements/file/monthly_invoice?month=${record.month_period}&currency=${record.currency}`
    },
    uploaded_by: record.uploaded_by,
    uploaded_at: record.uploaded_at,
    updated_at: record.updated_at
  };
}

router.get('/', authenticateToken, async (req, res) => {
  try {
    const monthPeriod = normalizeMonth(req.query.month);
    const currency = normalizeCurrency(req.query.currency);
    if (!monthPeriod) return res.status(400).json({ success: false, error: 'month is required in YYYY-MM format' });
    if (!VALID_CURRENCIES.has(currency)) return res.status(400).json({ success: false, error: 'currency must be one of AED, USD, GBP' });

    const record = await MonthlyBankStatement.getOne({ monthPeriod, currency });
    return res.json({ success: true, data: formatResponse(record) });
  } catch (error) {
    console.error('GET monthly bank statement error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch monthly bank statement' });
  }
});

router.get('/file/:type', authenticateToken, async (req, res) => {
  try {
    const monthPeriod = normalizeMonth(req.query.month);
    const currency = normalizeCurrency(req.query.currency);
    const fileType = String(req.params.type || '').trim();
    if (!monthPeriod) return res.status(400).json({ success: false, error: 'month is required in YYYY-MM format' });
    if (!VALID_CURRENCIES.has(currency)) return res.status(400).json({ success: false, error: 'currency must be one of AED, USD, GBP' });
    if (!VALID_FILE_TYPES.has(fileType)) return res.status(400).json({ success: false, error: 'type must be bank_statement or monthly_invoice' });

    const record = await MonthlyBankStatement.getOne({ monthPeriod, currency });
    if (!record) return res.status(404).json({ success: false, error: 'No monthly bank statement record found for the given month and currency' });

    const filePath = fileType === 'bank_statement' ? record.bank_statement_file_path : record.monthly_invoice_file_path;
    const downloadName = fileType === 'bank_statement'
      ? (record.bank_statement_original_filename || record.bank_statement_stored_filename)
      : (record.monthly_invoice_original_filename || record.monthly_invoice_stored_filename);

    const absolutePath = path.resolve(filePath);
    if (!absolutePath.startsWith(path.resolve(UPLOAD_DIR))) return res.status(400).json({ success: false, error: 'Invalid file path' });

    await fs.promises.access(absolutePath, fs.constants.F_OK);
    return res.download(absolutePath, downloadName);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ success: false, error: 'PDF file not found on server' });
    console.error('DOWNLOAD monthly bank statement error:', error);
    return res.status(500).json({ success: false, error: 'Failed to download PDF' });
  }
});

router.post('/', authenticateToken, monthlyBankStatementUploadMiddleware, async (req, res) => {
  let bankStatementFilePath;
  let monthlyInvoiceFilePath;
  try {
    const monthPeriod = normalizeMonth(req.body.month);
    const currency = normalizeCurrency(req.body.currency);
    const bankStatementFile = req.files?.bank_statement?.[0];
    const monthlyInvoiceFile = req.files?.monthly_invoice?.[0];
    if (!monthPeriod) return res.status(400).json({ success: false, error: 'month is required in YYYY-MM format' });
    if (!VALID_CURRENCIES.has(currency)) return res.status(400).json({ success: false, error: 'currency must be one of AED, USD, GBP' });
    if (!bankStatementFile || !monthlyInvoiceFile) {
      return res.status(400).json({ success: false, error: 'Both PDF files are required (form-data keys: bank_statement, monthly_invoice)' });
    }

    const currencyMonthDir = path.join(UPLOAD_DIR, currency, monthPeriod);
    await fs.promises.mkdir(currencyMonthDir, { recursive: true });

    const bankOriginal = sanitizeFilename(bankStatementFile.originalname || 'bank-statement.pdf');
    const invoiceOriginal = sanitizeFilename(monthlyInvoiceFile.originalname || 'monthly-invoice.pdf');
    const bankStored = `${Date.now()}-bank-${bankOriginal}`;
    const invoiceStored = `${Date.now()}-invoice-${invoiceOriginal}`;
    bankStatementFilePath = path.join(currencyMonthDir, bankStored);
    monthlyInvoiceFilePath = path.join(currencyMonthDir, invoiceStored);

    await fs.promises.writeFile(bankStatementFilePath, bankStatementFile.buffer);
    await fs.promises.writeFile(monthlyInvoiceFilePath, monthlyInvoiceFile.buffer);

    const previous = await MonthlyBankStatement.getOne({ monthPeriod, currency });
    const saved = await MonthlyBankStatement.upsert({
      monthPeriod,
      currency,
      bankStatement: {
        originalFilename: bankOriginal,
        storedFilename: bankStored,
        filePath: bankStatementFilePath,
        mimeType: bankStatementFile.mimetype || 'application/pdf',
        fileSize: bankStatementFile.size || null
      },
      monthlyInvoice: {
        originalFilename: invoiceOriginal,
        storedFilename: invoiceStored,
        filePath: monthlyInvoiceFilePath,
        mimeType: monthlyInvoiceFile.mimetype || 'application/pdf',
        fileSize: monthlyInvoiceFile.size || null
      },
      uploadedBy: req.user?.id || null
    });

    if (previous) {
      if (previous.bank_statement_file_path && previous.bank_statement_file_path !== bankStatementFilePath) await removeFileIfExists(previous.bank_statement_file_path);
      if (previous.monthly_invoice_file_path && previous.monthly_invoice_file_path !== monthlyInvoiceFilePath) await removeFileIfExists(previous.monthly_invoice_file_path);
    }

    return res.status(201).json({
      success: true,
      message: 'Monthly bank statement and invoice uploaded successfully',
      data: formatResponse(saved)
    });
  } catch (error) {
    if (bankStatementFilePath) await removeFileIfExists(bankStatementFilePath);
    if (monthlyInvoiceFilePath) await removeFileIfExists(monthlyInvoiceFilePath);
    console.error('UPLOAD monthly bank statement error:', error);
    return res.status(500).json({ success: false, error: 'Failed to upload monthly bank statement PDFs' });
  }
});

router.delete('/', authenticateToken, async (req, res) => {
  try {
    const monthPeriod = normalizeMonth(req.query.month);
    const currency = normalizeCurrency(req.query.currency);
    if (!monthPeriod) return res.status(400).json({ success: false, error: 'month is required in YYYY-MM format' });
    if (!VALID_CURRENCIES.has(currency)) return res.status(400).json({ success: false, error: 'currency must be one of AED, USD, GBP' });

    const current = await MonthlyBankStatement.getOne({ monthPeriod, currency });
    if (!current) return res.status(404).json({ success: false, error: 'No monthly bank statement record found for the given month and currency' });

    await MonthlyBankStatement.clear({ monthPeriod, currency });
    await removeFileIfExists(current.bank_statement_file_path);
    await removeFileIfExists(current.monthly_invoice_file_path);
    return res.json({ success: true, message: 'Monthly bank statement and invoice removed successfully' });
  } catch (error) {
    console.error('DELETE monthly bank statement error:', error);
    return res.status(500).json({ success: false, error: 'Failed to delete monthly bank statement PDFs' });
  }
});

module.exports = router;
