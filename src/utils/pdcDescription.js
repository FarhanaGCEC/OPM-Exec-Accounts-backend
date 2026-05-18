/**
 * Edit forms may send full remarks like "GCEC PDC, note text".
 * Store only the latest free-text note in post_dated_cheques.description.
 */
function normalizePdcDescriptionInput(rawDescription, pdcType) {
  if (rawDescription == null) return null;
  const trimmed = String(rawDescription).trim();
  if (!trimmed) return null;
  const normalizedType = String(pdcType || '').trim().toLowerCase();
  if (normalizedType && trimmed.toLowerCase() === normalizedType) {
    return null;
  }
  const typePrefix = `${String(pdcType || '').trim()},`;
  if (typePrefix !== ',' && trimmed.startsWith(typePrefix)) {
    const withoutPrefix = trimmed.slice(typePrefix.length).trim();
    return withoutPrefix || null;
  }
  return trimmed;
}

module.exports = { normalizePdcDescriptionInput };
