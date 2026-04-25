const express = require('express');
const fs = require('fs');
const path = require('path');
const { authenticateToken } = require('../middleware/auth');
const { dailyBankStatementUploadMiddleware } = require('../middleware/dailyBankStatementUpload');
const DailyBankStatement = require('../models/DailyBankStatement');
const { parseStatementTotalsFromPdfBuffer, parseStatementTotalsFromPdfPath } = require('../utils/parseStatementTotalsFromPdf');

const router = express.Router();

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'daily-bank-statements');

function sanitizeFilename(name) {
  return String(name || 'statement.pdf')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

async function removeFileIfExists(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to remove previous daily bank statement file:', error.message);
    }
  }
}

function formatResponse(record) {
  if (!record) return null;
  return {
    id: record.id,
    original_filename: record.original_filename,
    stored_filename: record.stored_filename,
    mime_type: record.mime_type,
    file_size: record.file_size,
    uploaded_by: record.uploaded_by,
    uploaded_at: record.uploaded_at,
    updated_at: record.updated_at,
    download_url: '/api/daily-bank-statement/file'
  };
}

function hasExtractedAmounts(extracted) {
  return extracted
    && (extracted.totalDebitAmount != null
      || extracted.totalCreditAmount != null
      || extracted.ledgerBalance != null);
}

function getExtractedTotalsFromRecord(record) {
  if (!record) return null;
  const extracted = {
    totalDebitAmount: record.statement_total_debit_amount != null ? Number(record.statement_total_debit_amount) : null,
    totalCreditAmount: record.statement_total_credit_amount != null ? Number(record.statement_total_credit_amount) : null,
    ledgerBalance: record.statement_ledger_balance != null ? Number(record.statement_ledger_balance) : null
  };
  return hasExtractedAmounts(extracted) ? extracted : null;
}

router.get('/', authenticateToken, async (_req, res) => {
  try {
    const current = await DailyBankStatement.getCurrent();
    let extractedTotals = getExtractedTotalsFromRecord(current);
    if (!extractedTotals) {
      const readablePath = await DailyBankStatement.resolveReadableFilePath(current);
      if (readablePath) {
        try {
          extractedTotals = await parseStatementTotalsFromPdfPath(readablePath);
        } catch (parseError) {
          console.error('Failed to parse uploaded daily bank statement PDF:', parseError.message);
        }
      }
    }
    return res.json({
      success: true,
      data: {
        ...formatResponse(current),
        extracted_totals: hasExtractedAmounts(extractedTotals) ? extractedTotals : null
      }
    });
  } catch (error) {
    console.error('GET daily bank statement error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch daily bank statement'
    });
  }
});

router.get('/file', authenticateToken, async (_req, res) => {
  try {
    const current = await DailyBankStatement.getCurrent();
    if (!current) {
      return res.status(404).json({
        success: false,
        error: 'No daily bank statement PDF found'
      });
    }

    const readablePath = await DailyBankStatement.resolveReadableFilePath(current);
    if (!readablePath) {
      return res.status(404).json({
        success: false,
        error: 'PDF file not found on server'
      });
    }
    const absolutePath = path.resolve(readablePath);
    if (!absolutePath.startsWith(path.resolve(UPLOAD_DIR))) {
      return res.status(400).json({
        success: false,
        error: 'Invalid file path'
      });
    }

    await fs.promises.access(absolutePath, fs.constants.F_OK);
    return res.download(absolutePath, current.original_filename || current.stored_filename);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({
        success: false,
        error: 'PDF file not found on server'
      });
    }
    console.error('DOWNLOAD daily bank statement error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to download daily bank statement PDF'
    });
  }
});

router.post('/', authenticateToken, dailyBankStatementUploadMiddleware, async (req, res) => {
  let newFilePath;
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'PDF file is required (form-data key: file)'
      });
    }

    await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });

    const safeOriginal = sanitizeFilename(req.file.originalname || 'daily-bank-statement.pdf');
    const storedFilename = `${Date.now()}-${safeOriginal}`;
    newFilePath = path.join(UPLOAD_DIR, storedFilename);

    await fs.promises.writeFile(newFilePath, req.file.buffer);

    let extractedTotals = null;
    try {
      extractedTotals = await parseStatementTotalsFromPdfBuffer(req.file.buffer);
    } catch (parseError) {
      // Upload must not fail just because extraction failed.
      console.error('Failed to parse uploaded daily bank statement PDF during upload:', parseError.message);
    }

    const previous = await DailyBankStatement.getCurrent();
    const saved = await DailyBankStatement.upsert({
      originalFilename: safeOriginal,
      storedFilename,
      filePath: newFilePath,
      mimeType: req.file.mimetype || 'application/pdf',
      fileSize: req.file.size || null,
      uploadedBy: req.user?.id || null,
      statementTotalDebitAmount: extractedTotals?.totalDebitAmount ?? null,
      statementTotalCreditAmount: extractedTotals?.totalCreditAmount ?? null,
      statementLedgerBalance: extractedTotals?.ledgerBalance ?? null
    });

    if (previous && previous.file_path && previous.file_path !== newFilePath) {
      await removeFileIfExists(previous.file_path);
    }

    return res.status(201).json({
      success: true,
      message: 'Daily bank statement uploaded successfully. Previous PDF replaced.',
      data: {
        ...formatResponse(saved),
        extracted_totals: hasExtractedAmounts(extractedTotals) ? extractedTotals : null
      }
    });
  } catch (error) {
    if (newFilePath) {
      await removeFileIfExists(newFilePath);
    }
    console.error('UPLOAD daily bank statement error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to upload daily bank statement PDF'
    });
  }
});

router.get('/extracted-totals', authenticateToken, async (_req, res) => {
  try {
    const current = await DailyBankStatement.getCurrent();
    if (!current) {
      return res.status(404).json({
        success: false,
        error: 'No daily bank statement PDF found'
      });
    }

    const readablePath = await DailyBankStatement.resolveReadableFilePath(current);
    if (!readablePath) {
      return res.status(404).json({
        success: false,
        error: 'PDF file not found on server'
      });
    }
    const absolutePath = path.resolve(readablePath);
    if (!absolutePath.startsWith(path.resolve(UPLOAD_DIR))) {
      return res.status(400).json({
        success: false,
        error: 'Invalid file path'
      });
    }

    await fs.promises.access(absolutePath, fs.constants.F_OK);
    const extractedTotals = await parseStatementTotalsFromPdfPath(absolutePath);
    if (!hasExtractedAmounts(extractedTotals)) {
      return res.status(422).json({
        success: false,
        error: 'Unable to extract required totals from the uploaded PDF'
      });
    }

    return res.json({
      success: true,
      data: extractedTotals
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({
        success: false,
        error: 'PDF file not found on server'
      });
    }
    console.error('GET daily bank statement extracted totals error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to extract totals from daily bank statement PDF'
    });
  }
});

router.delete('/', authenticateToken, async (_req, res) => {
  try {
    const current = await DailyBankStatement.getCurrent();
    if (!current) {
      return res.status(404).json({
        success: false,
        error: 'No daily bank statement PDF found'
      });
    }

    await DailyBankStatement.clear();
    await removeFileIfExists(current.file_path);

    return res.json({
      success: true,
      message: 'Daily bank statement removed successfully'
    });
  } catch (error) {
    console.error('DELETE daily bank statement error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to delete daily bank statement PDF'
    });
  }
});

module.exports = router;
