/**
 * Parse bank-style ledger CSV (Date, Description, Details, Debit, Credit, optional Balance, optional Remarks).
 * Details: DD, Online, Cash (case-insensitive), or an all-numeric cheque reference.
 */

const MONTH_SHORT = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n') {
      row.push(cur);
      cur = '';
      if (row.some((cell) => String(cell).trim() !== '')) {
        rows.push(row);
      }
      row = [];
    } else if (c === '\r') {
      // ignore; \r\n handled at \n
    } else {
      cur += c;
    }
  }
  row.push(cur);
  if (row.some((cell) => String(cell).trim() !== '')) {
    rows.push(row);
  }
  return rows;
}

function normalizeHeaderCell(h) {
  return String(h ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function mapHeaderToKey(normalized) {
  if (/^date$/.test(normalized)) return 'date';
  if (/^(description|particulars|narrative)$/.test(normalized)) return 'description';
  if (/^(details?|payment|mode|reference|ref)$/.test(normalized)) return 'details';
  if (/^(debit|withdrawal|dr)$/.test(normalized)) return 'debit';
  if (/^(credit|deposit|cr)$/.test(normalized)) return 'credit';
  if (/^(balance|bal)$/.test(normalized)) return 'balance';
  if (/^(remarks?|notes?|note)$/.test(normalized)) return 'remarks';
  return null;
}

function parseLedgerDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const dmySlash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (dmySlash) {
    const day = parseInt(dmySlash[1], 10);
    const month = parseInt(dmySlash[2], 10);
    let year = parseInt(dmySlash[3], 10);
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const dMonY = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(s);
  if (dMonY) {
    const day = parseInt(dMonY[1], 10);
    const monKey = dMonY[2].toLowerCase();
    const month = MONTH_SHORT[monKey];
    if (!month) return null;
    let year = parseInt(dMonY[3], 10);
    if (year < 100) year += 2000;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }

  return null;
}

function parseAedAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || /^aed\s*0([.,]0+)?$/i.test(s)) return 0;
  s = s.replace(/^aed\s*/i, '').replace(/,/g, '').trim();
  const n = parseFloat(s);
  if (Number.isNaN(n) || n < 0) return null;
  return n;
}

/**
 * @param {string} raw
 * @returns {{ paymentType: string, chequeNumber: string | null } | { error: string }}
 */
function paymentFromDetails(raw) {
  const s = String(raw ?? '').trim();
  if (!s) {
    return { error: 'Details is empty (expected DD, Online, Cash, or cheque number)' };
  }
  const lower = s.toLowerCase();
  if (lower === 'dd' || lower === 'demand draft' || lower === 'd.d.' || lower === 'd.d') {
    return { paymentType: 'dd', chequeNumber: null };
  }
  if (lower === 'online') {
    return { paymentType: 'online', chequeNumber: null };
  }
  if (lower === 'cash') {
    return { paymentType: 'cash', chequeNumber: null };
  }
  const digitsOnly = s.replace(/\s/g, '');
  if (/^\d+$/.test(digitsOnly)) {
    return { paymentType: 'cheque', chequeNumber: digitsOnly };
  }
  return {
    error: `Details must be DD, Online, Cash, or digits-only cheque number (got "${s}")`
  };
}

function buildColumnMap(headerRow) {
  const map = {};
  headerRow.forEach((cell, idx) => {
    const key = mapHeaderToKey(normalizeHeaderCell(cell));
    if (key && map[key] === undefined) {
      map[key] = idx;
    }
  });
  return map;
}

/**
 * @param {Buffer} buffer
 * @returns {{ rows: Array<{ date: string, description: string, details: string, paymentType: string, chequeNumber: string | null, type: string, amount: number, remarks: string | null }>, errors: Array<{ line: number, error: string }> }}
 */
function parseBankLedgerBulkCsvBuffer(buffer) {
  const text = buffer.toString('utf8');
  const table = parseCsv(text);
  if (table.length === 0) {
    return { rows: [], errors: [{ line: 1, error: 'CSV is empty' }] };
  }

  const col = buildColumnMap(table[0]);
  const required = ['date', 'description', 'details', 'debit', 'credit'];
  const missing = required.filter((k) => col[k] === undefined);
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        {
          line: 1,
          error: `Missing column(s): ${missing.join(', ')}. Need headers like Date, Description, Details, Debit, Credit.`
        }
      ]
    };
  }

  const out = [];
  const errors = [];

  for (let r = 1; r < table.length; r++) {
    const lineNum = r + 1;
    const cells = table[r];
    const dateRaw = cells[col.date];
    const desc = cells[col.description] != null ? String(cells[col.description]).trim() : '';
    const detailsRaw = cells[col.details];
    const debitRaw = cells[col.debit];
    const creditRaw = cells[col.credit];
    const remarksCell =
      col.remarks !== undefined && cells[col.remarks] != null
        ? String(cells[col.remarks]).trim()
        : '';

    if (!String(dateRaw || '').trim() && !desc && !String(detailsRaw || '').trim()) {
      continue;
    }

    const ymd = parseLedgerDate(dateRaw);
    if (!ymd) {
      errors.push({ line: lineNum, error: `Invalid or missing date: "${dateRaw}"` });
      continue;
    }

    if (!desc) {
      errors.push({ line: lineNum, error: 'Description is required' });
      continue;
    }

    const pay = paymentFromDetails(detailsRaw);
    if (pay.error) {
      errors.push({ line: lineNum, error: pay.error });
      continue;
    }

    const debitAmt = parseAedAmount(debitRaw);
    const creditAmt = parseAedAmount(creditRaw);
    if (debitAmt === null) {
      errors.push({ line: lineNum, error: `Invalid debit amount: "${debitRaw}"` });
      continue;
    }
    if (creditAmt === null) {
      errors.push({ line: lineNum, error: `Invalid credit amount: "${creditRaw}"` });
      continue;
    }

    if (debitAmt > 0 && creditAmt > 0) {
      errors.push({
        line: lineNum,
        error: 'Row has both debit and credit — only one side should be non-zero'
      });
      continue;
    }
    if (debitAmt === 0 && creditAmt === 0) {
      errors.push({
        line: lineNum,
        error: 'Debit and credit are both zero — skip empty rows in the file or use a real amount'
      });
      continue;
    }

    const type = debitAmt > 0 ? 'Debit' : 'Credit';
    const amount = debitAmt > 0 ? debitAmt : creditAmt;
    const remarks = remarksCell || null;

    out.push({
      date: ymd,
      description: desc,
      details: String(detailsRaw ?? '').trim(),
      paymentType: pay.paymentType,
      chequeNumber: pay.chequeNumber,
      type,
      amount,
      remarks
    });
  }

  if (out.length === 0 && errors.length === 0) {
    errors.push({ line: 0, error: 'No data rows found after the header' });
  }

  return { rows: out, errors };
}

module.exports = {
  parseBankLedgerBulkCsvBuffer,
  paymentFromDetails,
  parseLedgerDate,
  parseAedAmount
};
