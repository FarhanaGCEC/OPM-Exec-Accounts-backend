const path = require('path');
const fs = require('fs').promises;
const { cloudinary, isCloudinaryConfigured } = require('../config/cloudinary');
const { inferCloudinaryResourceType } = require('./cloudinaryAttachmentStream');

const LEGACY_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'card-statements');

async function fetchBufferFromUrl(url) {
  const upstream = await fetch(url);
  if (!upstream.ok) {
    throw new Error(`HTTP ${upstream.status} fetching attachment`);
  }
  return Buffer.from(await upstream.arrayBuffer());
}

/**
 * Load statement attachment bytes from Cloudinary, public URL, or legacy disk.
 * @returns {Promise<{ buffer: Buffer, kind: 'pdf'|'image' }|null>}
 */
async function fetchStatementAttachmentBuffer(row) {
  if (!row) return null;

  const name = row.attachment_name || '';
  const url = row.attachment_url || '';
  const publicId = row.attachment_cloudinary_public_id;
  const isPdfHint =
    /\.pdf($|\?)/i.test(name) ||
    /\.pdf($|\?)/i.test(url) ||
    String(url).includes('/raw/upload/');

  if (publicId && isCloudinaryConfigured()) {
    const resourceType = inferCloudinaryResourceType({
      name,
      url,
      explicitType: String(url).includes('/raw/upload/') ? 'raw' : undefined,
    });
    const rt = resourceType === 'image' ? 'image' : 'raw';
    try {
      const signedUrl = cloudinary.utils.private_download_url(publicId, '', {
        resource_type: rt,
        type: 'upload',
        expires_at: Math.floor(Date.now() / 1000) + 600,
      });
      const buffer = await fetchBufferFromUrl(signedUrl);
      const kind =
        buffer.length >= 4 && buffer.slice(0, 4).toString() === '%PDF'
          ? 'pdf'
          : isPdfHint
            ? 'pdf'
            : 'image';
      return { buffer, kind };
    } catch (e) {
      // Fall through to URL / disk
      console.warn(
        `[STATEMENT] Cloudinary fetch failed for ${row.id}:`,
        e.message
      );
    }
  }

  if (url && /^https?:\/\//i.test(String(url))) {
    try {
      const buffer = await fetchBufferFromUrl(String(url));
      const kind =
        buffer.length >= 4 && buffer.slice(0, 4).toString() === '%PDF'
          ? 'pdf'
          : isPdfHint
            ? 'pdf'
            : 'image';
      return { buffer, kind };
    } catch (e) {
      console.warn(`[STATEMENT] URL fetch failed for ${row.id}:`, e.message);
    }
  }

  if (row.attachment_storage_key) {
    const absPath = path.join(LEGACY_UPLOAD_DIR, row.attachment_storage_key);
    try {
      const buffer = await fs.readFile(absPath);
      const kind =
        buffer.length >= 4 && buffer.slice(0, 4).toString() === '%PDF'
          ? 'pdf'
          : isPdfHint
            ? 'pdf'
            : 'image';
      return { buffer, kind };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn(`[STATEMENT] Disk read failed for ${row.id}:`, e.message);
      }
    }
  }

  return null;
}

module.exports = {
  fetchStatementAttachmentBuffer,
};
