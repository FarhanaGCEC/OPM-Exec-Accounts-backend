/**
 * Extract Available Credit Limit / Available Limit / Credit Limit from statement PDFs.
 * Handles common UAE bank layouts where labels and amounts are separated or glued.
 * Falls back to OCR when the PDF has little/no extractable text (scans / image PDFs).
 */
const {
  extractTextFromPdfBuffer,
  normalizeNumberString,
} = require('./parseStatementTotalsFromPdf');
const { ocrPdfFirstPage, ocrImageBuffer } = require('./ocrStatementPage');

/** Match Available / Avaliable / Avaibble (OCR typos) + Credit Limit variants. */
const AVAIL_WORD =
  '(?:available|avaliable|availiable|availble|avaialble|avaibble|avaible|availabie)';
const AVAILABLE_CREDIT_LIMIT_RE = new RegExp(
  `${AVAIL_WORD}\\s*cred(?:it)?\\s*limit|${AVAIL_WORD}\\s*creditlimit|${AVAIL_WORD}\\s*cred\\s*limit`,
  'i'
);
const AVAILABLE_LIMIT_RE = new RegExp(
  `${AVAIL_WORD}\\s*limit\\b|الحد\\s*المتوف`,
  'i'
);

const MAX_PLAUSIBLE_LIMIT = 100_000_000;
const MIN_TEXT_CHARS_BEFORE_OCR = 40;

const AMOUNT_TOKEN =
  /(?:AED|USD|GBP|د\.?إ)?\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+\.[0-9]{2})/gi;

const PURE_AMOUNT_LINE =
  /^(?:AED|USD|GBP)?\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+\.[0-9]{2})\s*$/i;

const DATE_LINE = /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/;

function isPlausibleLimit(value) {
  if (value == null || Number.isNaN(value)) return false;
  if (value < 0 || value > MAX_PLAUSIBLE_LIMIT) return false;
  return true;
}

function collectAmounts(slice) {
  const amounts = [];
  const re = new RegExp(AMOUNT_TOKEN.source, 'gi');
  let match;
  while ((match = re.exec(slice)) !== null) {
    const parsed = normalizeNumberString(match[1]);
    if (isPlausibleLimit(parsed)) amounts.push(parsed);
  }
  return amounts;
}

/** OCR sometimes drops the decimal: 1480235 → 14802.35 */
function normalizeOcrBareIntegerAmount(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!/^\d{5,9}$/.test(digits)) return null;
  const withDecimals = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  const parsed = Number(withDecimals);
  return isPlausibleLimit(parsed) ? parsed : null;
}

/**
 * ENBD summary row (amounts glued, labels earlier on the page):
 *   15000013,204.6702/07/202627/07/202614,259.71
 *   150000362.2802/04/202627/04/202615,757.23   (available < 1,000, no comma)
 */
function splitEnbdCreditAndAvailable(left) {
  // Prefer amount with thousands commas (no leading zero stolen from credit)
  const availComma = left.match(/([1-9][0-9]{0,2}(?:,[0-9]{3})+\.[0-9]{2})$/);
  if (availComma) {
    const creditStr = left.slice(0, availComma.index);
    if (/^\d{4,7}$/.test(creditStr)) {
      return { creditStr, availableStr: availComma[1] };
    }
  }

  // Small available (< 1,000) has no thousands comma: 150000362.28
  const availSmall = left.match(/(\d{1,3}\.\d{2})$/);
  if (availSmall) {
    const creditStr = left.slice(0, availSmall.index);
    const creditNum = Number(creditStr);
    if (/^\d{4,7}$/.test(creditStr) && creditNum >= 1000 && creditNum % 1000 === 0) {
      return { creditStr, availableStr: availSmall[1] };
    }
  }

  return null;
}

function extractEnbdSummaryRow(text) {
  if (!/available\s*credit\s*limit/i.test(text)) return null;

  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const tail = line.match(
      /^(.+?)(\d{2}\/\d{2}\/\d{2,4})(\d{2}\/\d{2}\/\d{2,4})([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})$/
    );
    if (!tail) continue;

    const split = splitEnbdCreditAndAvailable(tail[1]);
    if (!split) continue;

    const credit = normalizeNumberString(split.creditStr);
    const available = normalizeNumberString(split.availableStr);
    if (!isPlausibleLimit(available)) continue;
    if (credit != null && available > credit + 1) continue;
    return available;
  }
  return null;
}

/**
 * EIB summary row — glued OR spaced (OCR of Infinite statements):
 *   25,000.009,807.673,565.1204/08/269,805.67
 *   150,000.00 78,084.18 3,595.79 05/07/26 71,915.62
 *   = CardLimit | AvailableLimit | MinPayment | DueDate | TotalDue
 */
function extractEibSummaryRow(text) {
  if (
    !/available\s*limit/i.test(text) &&
    !/card\s*limit/i.test(text) &&
    !/الحد\s*المتوف/i.test(text)
  ) {
    return null;
  }

  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1] || '';

    // Spaced OCR row (optionally on the line after the headers)
    for (const candidate of [line, next]) {
      const spaced = candidate.match(
        /^([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})\s+([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})\s+([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})\s+(\d{2}\/\d{2}\/\d{2,4})\s+([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})/
      );
      if (spaced) {
        // Only accept if this line is near Card/Available Limit headers
        const ctx = `${lines[i - 1] || ''} ${line} ${next}`;
        if (!/card\s*limit|available\s*limit|الحد\s*المتوف/i.test(ctx) && i > 0) {
          // still ok if candidate itself starts with large round card limit
        }
        const cardLimit = normalizeNumberString(spaced[1]);
        const available = normalizeNumberString(spaced[2]);
        if (!isPlausibleLimit(available)) continue;
        if (cardLimit != null && available > cardLimit + 1) continue;
        // Prefer rows where first amount looks like a card limit (>= 10k, round hundreds)
        if (cardLimit != null && cardLimit >= 10000) return available;
      }
    }

    // Glued row (text-layer EIB)
    const glued = line.match(
      /^([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})(\d{2}\/\d{2}\/\d{2,4})([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})$/
    );
    if (glued) {
      const cardLimit = normalizeNumberString(glued[1]);
      const available = normalizeNumberString(glued[2]);
      if (!isPlausibleLimit(available)) continue;
      if (cardLimit != null && available > cardLimit + 1) continue;
      return available;
    }
  }
  return null;
}

/**
 * Flat / glued layouts (CBD, Deem, SCB) + OCR typo tolerance.
 */
function extractFromFlatText(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return null;

  // Deem / multi-label row FIRST (before direct match grabs Credit Limit amount):
  // Credit Limit Avaliable Credit Limit ... AED 75,000 AED 60,853.60
  const labelRow = source.match(
    new RegExp(
      `credit\\s*limit\\s*${AVAIL_WORD}\\s*cred(?:it)?\\s*limit[\\s\\S]{0,220}?((?:AED\\s*[0-9,]+\\.?[0-9]*){2,})`,
      'i'
    )
  );
  if (labelRow) {
    const amounts = collectAmounts(labelRow[1]);
    if (amounts.length >= 2) return amounts[1];
    if (amounts.length === 1) return amounts[0];
  }

  // Direct: Available Credit Limit24,522.50 (OCR: Avaliable / Cred Limit)
  const directAvailableCredit = source.match(
    new RegExp(
      `${AVAIL_WORD}\\s*cred(?:it)?\\s*limit\\s*(?:\\(AED\\)\\*?)?\\s*(?:AED|USD|GBP)?\\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]{1,2})?|[0-9]+\\.[0-9]{2})`,
      'i'
    )
  );
  if (directAvailableCredit) {
    const parsed = normalizeNumberString(directAvailableCredit[1]);
    // If Credit Limit sits just before Available, this first amount is often the credit limit — skip
    const idx = source.search(AVAILABLE_CREDIT_LIMIT_RE);
    const before = idx >= 0 ? source.slice(Math.max(0, idx - 40), idx) : '';
    if (isPlausibleLimit(parsed) && !/credit\s*limit/i.test(before)) return parsed;
    if (isPlausibleLimit(parsed) && /credit\s*limit/i.test(before)) {
      const window = source.slice(idx, idx + 200);
      const amounts = collectAmounts(window);
      if (amounts.length >= 2) return amounts[1];
    } else if (isPlausibleLimit(parsed)) {
      return parsed;
    }
  }

  // OCR same-line without decimal: Available creditlimit ~~ 1480235
  const ocrBare = source.match(
    new RegExp(
      `${AVAIL_WORD}\\s*cred(?:it)?(?:\\s*limit|limit)\\s*[~\\-–—|]*\\s*(\\d{5,9})(?!\\d)`,
      'i'
    )
  );
  if (ocrBare) {
    const parsed = normalizeOcrBareIntegerAmount(ocrBare[1]);
    if (parsed != null) return parsed;
  }

  const directAvailable = source.match(
    new RegExp(
      `${AVAIL_WORD}\\s*limit\\s*(?:\\(AED\\)\\*?)?\\s*(?:AED|USD|GBP)?\\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]{1,2})?|[0-9]+\\.[0-9]{2})`,
      'i'
    )
  );
  if (directAvailable) {
    const parsed = normalizeNumberString(directAvailable[1]);
    if (isPlausibleLimit(parsed)) return parsed;
  }

  const availIdx = source.search(AVAILABLE_CREDIT_LIMIT_RE);
  if (availIdx >= 0) {
    const window = source.slice(availIdx, availIdx + 260);
    const amounts = collectAmounts(window);
    if (amounts.length >= 3 && /available\s*cash\s*limit/i.test(window)) {
      return amounts[1];
    }
    if (amounts.length >= 2) {
      const before = source.slice(Math.max(0, availIdx - 60), availIdx);
      // Deem-style: bare "Credit Limit" then "Available Credit Limit" then [credit, available]
      // Do NOT treat Mashreq "Combined credit limit" as that pattern
      if (
        /(?:^|[^a-z])credit\s*limit/i.test(before) &&
        !/combined\s*credit\s*limit/i.test(before)
      ) {
        return amounts[1];
      }
      return amounts[0];
    }
    if (amounts.length === 1) {
      const amountAt = window.search(AMOUNT_TOKEN);
      if (amountAt >= 0 && amountAt < 100) return amounts[0];
    }
  }

  const availLimitIdx = source.search(AVAILABLE_LIMIT_RE);
  if (availLimitIdx >= 0) {
    const window = source.slice(availLimitIdx, availLimitIdx + 160);
    const amounts = collectAmounts(window);
    if (amounts.length && !/minimum\s*payment|payment\s*due|total\s*payment/i.test(window)) {
      return amounts[0];
    }
  }

  if (!AVAILABLE_CREDIT_LIMIT_RE.test(source) && !AVAILABLE_LIMIT_RE.test(source)) {
    const credit = source.match(
      /credit\s*limit\s*(?:\(AED\)\*?)?\s*(?:AED|USD|GBP)?\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+\.[0-9]{2})/i
    );
    if (credit) {
      const parsed = normalizeNumberString(credit[1]);
      if (isPlausibleLimit(parsed)) return parsed;
    }
  }

  return null;
}

/**
 * Mashreq / same-line layouts.
 */
function extractFromLineLayout(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Same row: "Available credit limit    12,317.00"
    const sameLine = line.match(
      new RegExp(
        `^${AVAIL_WORD}\\s*cred(?:it)?(?:\\s*limit|limit)\\s*(?:\\(AED\\))?\\s*[~\\-–—|]*\\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]{1,2})?|[0-9]+\\.[0-9]{2}|\\d{5,9})\\s*$`,
        'i'
      )
    );
    if (sameLine) {
      let parsed = normalizeNumberString(sameLine[1]);
      if (!isPlausibleLimit(parsed)) parsed = normalizeOcrBareIntegerAmount(sameLine[1]);
      if (isPlausibleLimit(parsed)) return parsed;
    }
    const sameLineAvail = line.match(
      new RegExp(
        `^${AVAIL_WORD}\\s*limit\\s*(?:\\(AED\\))?\\s+([0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]{1,2})?|[0-9]+\\.[0-9]{2})\\s*$`,
        'i'
      )
    );
    if (sameLineAvail) {
      const parsed = normalizeNumberString(sameLineAvail[1]);
      if (isPlausibleLimit(parsed)) return parsed;
    }

    const isAvailableCredit =
      new RegExp(`^${AVAIL_WORD}\\s*cred(?:it)?(?:\\s*limit|limit)\\b`, 'i').test(line) ||
      /^available\s*creditlimit\b/i.test(line);
    const isAvailableLimit = new RegExp(`^${AVAIL_WORD}\\s*limit\\b`, 'i').test(line);
    if (!isAvailableCredit && !isAvailableLimit) continue;

    const hasCombinedBefore =
      i > 0 && /combined\s*credit\s*limit/i.test(lines[i - 1]);
    const hasCashAfter =
      i + 1 < lines.length && /available\s*cash\s*limit/i.test(lines[i + 1]);

    const maxLookahead = hasCombinedBefore && hasCashAfter ? 40 : 6;
    const amounts = [];

    for (let j = i + 1; j < Math.min(lines.length, i + 1 + maxLookahead); j += 1) {
      const cur = lines[j];
      if (DATE_LINE.test(cur)) continue;
      if (/^(amount|date|signature|aed|usd|gbp)$/i.test(cur)) continue;
      if (/please detach|pay the outstanding|mashreq account|enclosed cheque/i.test(cur)) {
        continue;
      }

      const pure = cur.match(PURE_AMOUNT_LINE);
      if (pure) {
        const parsed = normalizeNumberString(pure[1]);
        if (isPlausibleLimit(parsed)) amounts.push(parsed);
        continue;
      }

      const multi = collectAmounts(cur);
      if (multi.length >= 2) {
        amounts.push(...multi);
        continue;
      }

      if (amounts.length > 0 && /[A-Za-z\u0600-\u06FF]{3,}/.test(cur)) break;
    }

    if (!amounts.length) continue;

    if (hasCombinedBefore && hasCashAfter && amounts.length >= 3) {
      return amounts[amounts.length - 2];
    }
    if (amounts.length >= 3 && /available\s*cash\s*limit/i.test(lines.slice(i, i + 5).join(' '))) {
      return amounts[1];
    }
    if (amounts.length >= 2 && hasCombinedBefore) {
      return amounts[amounts.length - 2];
    }
    if (amounts.length === 1 && maxLookahead <= 6) return amounts[0];
  }

  return null;
}

/**
 * FAB layout: labels on their own lines, then a two-amount row:
 *   Total Credit Limit
 *   Available Credit Limit
 *   25,200.00         1,610.80
 */
function extractFabTwoAmountRow(text) {
  if (!/available\s*credit\s*limit/i.test(text)) return null;
  if (!/total\s*cre[a-z]{2,5}\s*limit/i.test(text)) return null;

  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const m = line.match(
      /^([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?|[0-9]+\.[0-9]{2})\s+([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?|[0-9]+\.[0-9]{2})\s*[).|]?\s*$/
    );
    if (!m) continue;
    const credit = normalizeNumberString(m[1]);
    const available = normalizeNumberString(m[2]);
    if (!isPlausibleLimit(available) || credit == null) continue;
    if (available > credit + 1) continue;
    // Prefer pairs where first amount looks like a card/total credit limit
    if (credit >= 1000) return available;
  }

  // Flat OCR: Total Credit Limit | Available Credit Limit ... 25,200.00 1,610.80
  const flat = String(text || '').replace(/\s+/g, ' ');
  const m = flat.match(
    /total\s*cre[a-z]{2,5}\s*limit[\s\S]{0,140}?available\s*cred(?:it)?\s*limit[\s\S]{0,160}?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?|[0-9]+\.[0-9]{2})\s+([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?|[0-9]+\.[0-9]{2})/i
  );
  if (m) {
    const credit = normalizeNumberString(m[1]);
    const available = normalizeNumberString(m[2]);
    if (isPlausibleLimit(available) && credit != null && available <= credit + 1) {
      return available;
    }
  }

  return null;
}

/**
 * ADCB Lulu-style (OCR often garbles white-on-dark "Available Credit Limit"):
 *   Total Credit Limit ........ 20,000.00
 *   Available Credit Limit .... 15,593.75
 *   Available Cash Limit ...... 12,000.00
 */
function extractAdcbLuluLimitRow(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return null;

  const looksAdcb =
    /total\s*credit\s*limi/i.test(source) ||
    /lulu\s*points|lulupoints|adcb/i.test(source) ||
    /total\s*outstanding/i.test(source);
  if (!looksAdcb) return null;

  const idx = source.search(/total\s*credit\s*limi/i);
  if (idx < 0) return null;

  const window = source.slice(idx, idx + 320);
  const amounts = collectAmounts(window);
  if (amounts.length < 2) return null;

  // First amount after "Total Credit Limit" is the credit limit; second is available.
  const credit = amounts[0];
  const available = amounts[1];
  if (!isPlausibleLimit(available) || credit == null) return null;
  if (available > credit + 1) return null;
  if (credit < 1000) return null;
  return available;
}

function extractAvailableLimitFromText(text) {
  return (
    extractFabTwoAmountRow(text) ??
    extractAdcbLuluLimitRow(text) ??
    extractEnbdSummaryRow(text) ??
    extractEibSummaryRow(text) ??
    extractFromLineLayout(text) ??
    extractFromFlatText(text)
  );
}

function isPdfBuffer(buffer) {
  return buffer.length >= 4 && buffer.slice(0, 4).toString() === '%PDF';
}

function isImageBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true; // jpeg
  }
  if (
    buffer.length >= 8 &&
    buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return true; // png
  }
  return false;
}

async function extractViaOcr(buffer) {
  try {
    let ocrText = '';
    if (isPdfBuffer(buffer)) {
      ocrText = await ocrPdfFirstPage(buffer);
    } else if (isImageBuffer(buffer)) {
      ocrText = await ocrImageBuffer(buffer);
    } else {
      return null;
    }
    if (!ocrText || ocrText.trim().length < 10) return null;
    return extractAvailableLimitFromText(ocrText);
  } catch (err) {
    console.warn('[STATEMENT] available_limit OCR failed:', err.message);
    return null;
  }
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<number|null>}
 */
async function parseAvailableLimitFromPdfBuffer(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  // Image attachment — OCR directly
  if (!isPdfBuffer(buffer)) {
    if (isImageBuffer(buffer)) return extractViaOcr(buffer);
    return null;
  }

  try {
    const firstPageText = await extractTextFromPdfBuffer(buffer, { firstPageOnly: true });
    const fromFirst = extractAvailableLimitFromText(firstPageText);
    if (fromFirst != null) return fromFirst;

    const fullText = await extractTextFromPdfBuffer(buffer, { firstPageOnly: false });
    const fromFull = extractAvailableLimitFromText(fullText);
    if (fromFull != null) return fromFull;

    // Scanned / image-only / custom-font PDFs: OCR first page
    const textLen = Math.max(
      String(firstPageText || '').trim().length,
      String(fullText || '').trim().length
    );
    const hasLimitLabel = new RegExp(
      `${AVAIL_WORD}\\s*(cred(?:it)?)?\\s*limit|credit\\s*limit|available\\s*creditlimit`,
      'i'
    ).test(`${firstPageText || ''}\n${fullText || ''}`);
    // OCR when almost no text, label present without amount, or text layer is useless.
    // Always try OCR for near-empty scans; also when limit labels exist but amounts weren't parseable.
    if (textLen < MIN_TEXT_CHARS_BEFORE_OCR || hasLimitLabel || textLen < 200) {
      console.log('[STATEMENT] available_limit trying OCR (textLen=%s, hasLabel=%s)', textLen, hasLimitLabel);
      return extractViaOcr(buffer);
    }

    return null;
  } catch (err) {
    console.warn('[STATEMENT] available_limit PDF parse failed:', err.message);
    // Last resort: try OCR anyway
    return extractViaOcr(buffer);
  }
}

module.exports = {
  extractAvailableLimitFromText,
  parseAvailableLimitFromPdfBuffer,
};
