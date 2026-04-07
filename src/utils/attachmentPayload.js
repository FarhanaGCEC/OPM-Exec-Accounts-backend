/**
 * Normalize stored media URLs for API consumers (images, PDFs).
 * Cloudinary sometimes returns protocol-relative URLs; browsers/embeds need an absolute https URL.
 */
function normalizeMediaUrl(url) {
  if (url === undefined || url === null) return null;
  const s = String(url).trim();
  if (!s) return null;
  if (s.startsWith('//')) {
    return `https:${s}`;
  }
  return s;
}

function buildAttachmentPayloadFromParts(name, url) {
  const resolved = normalizeMediaUrl(url);
  if (!resolved) return null;
  const displayName = (name && String(name).trim()) || 'attachment';
  return {
    name: displayName,
    url: resolved,
    attachmentUrl: resolved
  };
}

/** Credit card statement row from DB */
function buildStatementAttachmentPayload(row) {
  if (!row || !row.id) return null;
  if (row.attachment_url) {
    return buildAttachmentPayloadFromParts(row.attachment_name, row.attachment_url);
  }
  if (row.attachment_storage_key) {
    const rel = `/api/statements/${row.id}/attachment`;
    return {
      name: row.attachment_name || 'statement.pdf',
      url: rel,
      attachmentUrl: rel
    };
  }
  return null;
}

/** PDC cheque image from DB */
function buildPdcAttachmentPayload(pdc) {
  if (!pdc || !pdc.attachment_url) return null;
  return buildAttachmentPayloadFromParts(pdc.attachment_name || 'cheque-image', pdc.attachment_url);
}

module.exports = {
  normalizeMediaUrl,
  buildAttachmentPayloadFromParts,
  buildStatementAttachmentPayload,
  buildPdcAttachmentPayload
};
