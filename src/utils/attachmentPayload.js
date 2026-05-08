const path = require('path');

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

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.bmp', '.svg']);

function inferAttachmentKind({ name, url, resourceType } = {}) {
  const candidate = String(name || url || '').toLowerCase();
  const ext = path.extname(candidate);
  if (ext === '.pdf') return { type: 'pdf', mimeType: 'application/pdf' };
  if (resourceType === 'raw' && ext === '.pdf') return { type: 'pdf', mimeType: 'application/pdf' };
  if (IMAGE_EXTENSIONS.has(ext)) {
    const mime =
      ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.svg'
          ? 'image/svg+xml'
          : `image/${ext.slice(1)}`;
    return { type: 'image', mimeType: mime };
  }
  if (resourceType === 'image') return { type: 'image', mimeType: null };
  if (resourceType === 'raw') return { type: 'file', mimeType: null };
  return { type: 'file', mimeType: null };
}

function buildAttachmentPayloadFromParts(name, url, extras = {}) {
  const resolved = normalizeMediaUrl(url);
  if (!resolved) return null;
  const displayName = (name && String(name).trim()) || 'attachment';
  const { type, mimeType } = inferAttachmentKind({
    name: displayName,
    url: resolved,
    resourceType: extras.resourceType
  });
  return {
    name: displayName,
    url: resolved,
    attachmentUrl: resolved,
    type,
    mimeType,
    resourceType: extras.resourceType || null
  };
}

/** Credit card statement row from DB */
function buildStatementAttachmentPayload(row) {
  if (!row || !row.id) return null;
  if (row.attachment_url) {
    return buildAttachmentPayloadFromParts(row.attachment_name, row.attachment_url, {
      resourceType: 'raw'
    });
  }
  if (row.attachment_storage_key) {
    const rel = `/api/statements/${row.id}/attachment`;
    return {
      name: row.attachment_name || 'statement.pdf',
      url: rel,
      attachmentUrl: rel,
      type: 'pdf',
      mimeType: 'application/pdf',
      resourceType: 'raw'
    };
  }
  return null;
}

/** PDC cheque attachment from DB (image or pdf) */
function buildPdcAttachmentPayload(pdc) {
  if (!pdc || !pdc.attachment_url) return null;
  const isPdf =
    pdc.attachment_resource_type === 'raw' ||
    /\.pdf($|\?)/i.test(pdc.attachment_name || pdc.attachment_url);
  const fallbackName = isPdf ? 'cheque.pdf' : 'cheque-image';
  const displayName = (pdc.attachment_name && String(pdc.attachment_name).trim()) || fallbackName;
  const cloudinaryUrl = normalizeMediaUrl(pdc.attachment_url);
  // PDFs are proxied through our backend so Cloudinary's "PDF/ZIP delivery"
  // security toggle can't 401 the browser. Images use the direct CDN URL.
  // Path is intentionally relative to the API root (no leading /api) so
  // frontend api clients that already prepend their own baseURL (e.g. "/api")
  // don't end up requesting "/api/api/pdc/...".
  const url = isPdf && pdc.id != null ? `/pdc/${pdc.id}/attachment` : cloudinaryUrl;
  const { type, mimeType } = inferAttachmentKind({
    name: displayName,
    url: cloudinaryUrl,
    resourceType: pdc.attachment_resource_type
  });
  return {
    name: displayName,
    url,
    attachmentUrl: url,
    cloudinaryUrl,
    type,
    mimeType: mimeType || (isPdf ? 'application/pdf' : null),
    resourceType: pdc.attachment_resource_type || null
  };
}

module.exports = {
  normalizeMediaUrl,
  buildAttachmentPayloadFromParts,
  buildStatementAttachmentPayload,
  buildPdcAttachmentPayload,
  inferAttachmentKind
};
