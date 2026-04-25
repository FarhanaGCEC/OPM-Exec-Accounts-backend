const pdfParseLib = require('pdf-parse');

const AMOUNT_CAPTURE = '([\\(\\-]?[0-9][0-9,]*(?:\\.[0-9]{1,3})?\\)?)';
const CURRENCY_HINT = '(?:AED|USD|GBP|د\\.?إ)?';

function normalizeNumberString(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const isNegativeByBrackets = /^\(.*\)$/.test(raw);

  // Keep only characters that can represent decimal numbers.
  const cleaned = raw.replace(/[^0-9,.]/g, '');
  if (!cleaned) return null;

  // If both comma and dot exist, commas are likely thousands separators.
  // If only comma exists, treat comma as decimal separator.
  let normalized = cleaned;
  if (normalized.includes('.') && normalized.includes(',')) {
    normalized = normalized.replace(/,/g, '');
  } else if (!normalized.includes('.') && normalized.includes(',')) {
    normalized = normalized.replace(/,/g, '.');
  }

  const parsed = Number(normalized);
  if (Number.isNaN(parsed)) return null;
  return isNegativeByBrackets ? -Math.abs(parsed) : parsed;
}

function firstNonNull(values) {
  for (const value of values) {
    if (value != null) return value;
  }
  return null;
}

function buildLabelRegex(labelPatterns) {
  const joined = labelPatterns
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .join('|');
  return new RegExp(`(?:${joined})`, 'i');
}

function extractUsingLineHeuristic(text, labelRegex) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!labelRegex.test(line)) continue;
    const merged = `${line} ${lines[i + 1] || ''}`.trim();
    const amountMatch = merged.match(new RegExp(`${CURRENCY_HINT}\\s*${AMOUNT_CAPTURE}(?:\\s*(?:Dr|Cr))?`, 'i'));
    if (amountMatch && amountMatch[1]) {
      const parsed = normalizeNumberString(amountMatch[1]);
      if (parsed != null) return parsed;
    }
  }
  return null;
}

function extractByLabelVariants(text, labelPatterns) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return null;

  const labelRegex = buildLabelRegex(labelPatterns);

  const directRegex = new RegExp(
    `(?:${labelPatterns.join('|')})\\s*[:\\-]?\\s*${CURRENCY_HINT}\\s*${AMOUNT_CAPTURE}(?:\\s*(?:Dr|Cr))?`,
    'i'
  );
  const directMatch = source.match(directRegex);
  if (directMatch && directMatch[1]) {
    const parsed = normalizeNumberString(directMatch[1]);
    if (parsed != null) return parsed;
  }

  // Fallback: look for label then pick first amount in nearby text window.
  const labelIndex = source.search(labelRegex);
  if (labelIndex >= 0) {
    const window = source.slice(labelIndex, labelIndex + 180);
    const nearbyAmount = window.match(new RegExp(`${CURRENCY_HINT}\\s*${AMOUNT_CAPTURE}`, 'i'));
    if (nearbyAmount && nearbyAmount[1]) {
      const parsed = normalizeNumberString(nearbyAmount[1]);
      if (parsed != null) return parsed;
    }
  }

  return extractUsingLineHeuristic(text, labelRegex);
}

async function parseStatementTotalsFromPdfBuffer(buffer) {
  const legacyPdfParse = typeof pdfParseLib === 'function'
    ? pdfParseLib
    : (pdfParseLib && typeof pdfParseLib.default === 'function' ? pdfParseLib.default : null);
  const PdfParseClass = pdfParseLib && typeof pdfParseLib.PDFParse === 'function'
    ? pdfParseLib.PDFParse
    : null;

  async function extractText({ firstPageOnly }) {
    // Legacy pdf-parse API (function export).
    if (legacyPdfParse) {
      const parsed = await legacyPdfParse(buffer, firstPageOnly ? { max: 1 } : undefined);
      return parsed?.text || '';
    }

    // New pdf-parse API (class export).
    if (PdfParseClass) {
      const parser = new PdfParseClass({ data: buffer });
      try {
        const parsed = await parser.getText(firstPageOnly ? { max: 1 } : undefined);
        return parsed?.text || '';
      } finally {
        await parser.destroy();
      }
    }

    throw new Error('pdf-parse module export is not callable');
  }

  const extractTotalsFromText = (text) => ({
    totalDebitAmount: firstNonNull([
      extractByLabelVariants(text, [
        'total\\s*debit\\s*amount',
        'debit\\s*total',
        'total\\s*debit',
        'total\\s*withdrawals?'
      ])
    ]),
    totalCreditAmount: firstNonNull([
      extractByLabelVariants(text, [
        'total\\s*credit\\s*amount',
        'credit\\s*total',
        'total\\s*credit',
        'total\\s*deposits?'
      ])
    ]),
    ledgerBalance: firstNonNull([
      extractByLabelVariants(text, [
        'ledger\\s*balance',
        'closing\\s*balance',
        'ending\\s*balance',
        'current\\s*balance'
      ])
    ])
  });

  // The required totals are typically printed in the statement summary on page 1.
  const firstPageTotals = extractTotalsFromText(await extractText({ firstPageOnly: true }));
  if (
    firstPageTotals.totalDebitAmount != null
    || firstPageTotals.totalCreditAmount != null
    || firstPageTotals.ledgerBalance != null
  ) {
    return firstPageTotals;
  }

  // Fallback to full-document parsing when page 1 text is not extractable.
  return extractTotalsFromText(await extractText({ firstPageOnly: false }));
}

async function parseStatementTotalsFromPdfPath(filePath) {
  // pdf-parse accepts file buffers; readFile kept here to centralize parser usage.
  const fs = require('fs');
  const buffer = await fs.promises.readFile(filePath);
  return parseStatementTotalsFromPdfBuffer(buffer);
}

module.exports = {
  parseStatementTotalsFromPdfBuffer,
  parseStatementTotalsFromPdfPath
};
