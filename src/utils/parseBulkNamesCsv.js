/**
 * Parse a simple CSV (or single column per line) into category/display names.
 * First non-empty row may be a header (name, creditor, debtor, etc.) and is skipped.
 */
function parseBulkNamesFromCsvBuffer(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  const names = [];
  let isFirstNonEmpty = true;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let cell = t;
    const comma = t.indexOf(',');
    if (comma !== -1) {
      cell = t
        .slice(0, comma)
        .replace(/^\uFEFF/, '')
        .replace(/^"|"$/g, '')
        .trim();
    } else {
      cell = t.replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim();
    }
    if (
      isFirstNonEmpty &&
      /^(name|creditor|debtor|payable|receivable|category|description)\s*$/i.test(cell)
    ) {
      isFirstNonEmpty = false;
      continue;
    }
    isFirstNonEmpty = false;
    if (cell) names.push(cell);
  }
  return names;
}

module.exports = { parseBulkNamesFromCsvBuffer };
