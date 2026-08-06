/** UI may echo GET list values: "12,345.67" → number */
function normalizeStatementAmount(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' && !Number.isNaN(raw)) return raw;
  const n = parseFloat(String(raw).replace(/,/g, '').trim());
  return Number.isNaN(n) ? NaN : n;
}

/**
 * Parse partial amount entries (paid or EPP) from request body.
 * Accepts [{ amount, paid_at, note? }] objects, or JSON string (multipart).
 * paid_at is required (YYYY-MM-DD) for every entry.
 */
function parseAmountEntriesInput(raw, fieldName) {
  if (raw === undefined) {
    return { ok: true, entries: undefined, total: undefined };
  }
  if (raw === null || raw === '') {
    return { ok: true, entries: [], total: 0 };
  }
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, error: `${fieldName} must be a JSON array when sent as a string` };
    }
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: `${fieldName} must be an array of { amount, paid_at } objects`,
    };
  }

  const entries = [];
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (item == null || typeof item !== 'object' || Array.isArray(item)) {
      return {
        ok: false,
        error: `${fieldName}[${i}] must be an object with amount and paid_at (YYYY-MM-DD)`,
      };
    }
    const amountRaw = item.amount !== undefined ? item.amount : item.paid;
    let paidAt = item.paid_at != null ? item.paid_at : item.paidAt != null ? item.paidAt : null;
    const note = item.note != null ? item.note : null;

    const amount = normalizeStatementAmount(amountRaw);
    if (Number.isNaN(amount) || amount < 0) {
      return {
        ok: false,
        error: `${fieldName}[${i}].amount must be a valid number >= 0 (comma separators allowed)`,
      };
    }
    if (paidAt == null || paidAt === '') {
      return {
        ok: false,
        error: `${fieldName}[${i}].paid_at is required (YYYY-MM-DD)`,
      };
    }
    const s = String(paidAt).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return {
        ok: false,
        error: `${fieldName}[${i}].paid_at must be YYYY-MM-DD`,
      };
    }
    paidAt = s;

    entries.push({
      amount,
      paid_at: paidAt,
      note: note != null && String(note).trim() !== '' ? String(note).trim().slice(0, 255) : null,
      sort_order: i,
    });
    total = Math.round((total + amount) * 100) / 100;
  }

  return { ok: true, entries, total };
}

function parsePaymentsInput(raw) {
  const parsed = parseAmountEntriesInput(raw, 'payments');
  if (!parsed.ok) return parsed;
  return { ok: true, payments: parsed.entries, total: parsed.total };
}

function parseEppPaymentsInput(raw) {
  const parsed = parseAmountEntriesInput(raw, 'epp_payments');
  if (!parsed.ok) return parsed;
  return { ok: true, epp_payments: parsed.entries, total: parsed.total };
}

/**
 * Accept YYYY-MM-DD, DD/MM/YYYY, or DD-MM-YY (same pattern as list formatDateDDMMYY)
 */
function parseStatementDateInput(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: false, value: null };
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T12:00:00`);
    return isNaN(d.getTime()) ? { ok: false, value: null } : { ok: true, value: s };
  }
  if (s.includes('/')) {
    const parts = s.split('/').map((p) => p.trim());
    if (parts.length !== 3) return { ok: false, value: null };
    const [a, b, c] = parts;
    let y;
    let mo;
    let day;
    if (c.length === 4) {
      day = a.padStart(2, '0');
      mo = b.padStart(2, '0');
      y = c;
    } else {
      day = a.padStart(2, '0');
      mo = b.padStart(2, '0');
      y = c.length === 2 ? (parseInt(c, 10) >= 70 ? `19${c}` : `20${c}`) : c;
    }
    const iso = `${y}-${mo}-${day}`;
    const d = new Date(`${iso}T12:00:00`);
    return isNaN(d.getTime()) ? { ok: false, value: null } : { ok: true, value: iso };
  }
  const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (m) {
    const day = m[1].padStart(2, '0');
    const mo = m[2].padStart(2, '0');
    let y = m[3];
    if (y.length === 2) {
      y = parseInt(y, 10) >= 70 ? `19${y}` : `20${y}`;
    }
    const iso = `${y}-${mo}-${day}`;
    const d = new Date(`${iso}T12:00:00`);
    return isNaN(d.getTime()) ? { ok: false, value: null } : { ok: true, value: iso };
  }
  return { ok: false, value: null };
}

module.exports = {
  normalizeStatementAmount,
  parseStatementDateInput,
  parseAmountEntriesInput,
  parsePaymentsInput,
  parseEppPaymentsInput,
};
