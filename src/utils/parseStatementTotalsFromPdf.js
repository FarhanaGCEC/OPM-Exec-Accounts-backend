// Bypass pdf-parse/index.js — it runs test-file debug code when bundled (no module.parent).
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const AMOUNT_CAPTURE = '([\\(\\-]?[0-9][0-9,]*(?:\\.[0-9]{1,3})?\\)?)';
const CURRENCY_HINT = '(?:AED|USD|GBP|د\\.?إ)?';

function normalizeNumberString(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const isNegativeByBrackets = /^\(.*\)$/.test(raw);

  const cleaned = raw.replace(/[^0-9,.]/g, '');
  if (!cleaned) return null;

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

function extractTotalsFromText(text) {
  const closingAvailableBalance = firstNonNull([
    extractByLabelVariants(text, [
      'closing\\s*\\(\\s*available\\s*\\)\\s*balance',
      'closing\\s*\\(available\\)\\s*balance',
      'closing\\s*available\\s*balance',
      'closing\\s*\\(\\s*available\\s*\\)'
    ])
  ]);
  const currentBalance = firstNonNull([
    extractByLabelVariants(text, ['current\\s*balance']),
    closingAvailableBalance,
    extractByLabelVariants(text, [
      'ledger\\s*balance',
      'closing\\s*balance',
      'ending\\s*balance'
    ])
  ]);

  return {
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
    currentBalance,
    closingAvailableBalance,
    ledgerBalance: currentBalance
  };
}

async function extractTextFromPdfBuffer(buffer, { firstPageOnly }) {
  const parsed = await pdfParse(buffer, firstPageOnly ? { max: 1 } : undefined);
  return parsed?.text || '';
}

async function parseStatementTotalsFromPdfBuffer(buffer) {
  const firstPageTotals = extractTotalsFromText(await extractTextFromPdfBuffer(buffer, { firstPageOnly: true }));
  if (
    firstPageTotals.totalDebitAmount != null
    || firstPageTotals.totalCreditAmount != null
    || firstPageTotals.currentBalance != null
  ) {
    return firstPageTotals;
  }

  return extractTotalsFromText(await extractTextFromPdfBuffer(buffer, { firstPageOnly: false }));
}

async function parseStatementTotalsFromPdfPath(filePath) {
  const fs = require('fs');
  const buffer = await fs.promises.readFile(filePath);
  return parseStatementTotalsFromPdfBuffer(buffer);
}

module.exports = {
  parseStatementTotalsFromPdfBuffer,
  parseStatementTotalsFromPdfPath
};
