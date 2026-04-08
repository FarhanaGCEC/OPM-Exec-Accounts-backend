/** UI may echo GET list values: "12,345.67" → number */
function normalizeStatementAmount(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' && !Number.isNaN(raw)) return raw;
  const n = parseFloat(String(raw).replace(/,/g, '').trim());
  return Number.isNaN(n) ? NaN : n;
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
};
