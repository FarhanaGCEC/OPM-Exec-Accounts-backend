const path = require('path');
const fs = require('fs').promises;
const { randomUUID } = require('crypto');
const Statement = require('../models/Statement');
const {
  uploadStatementAttachment,
  destroyStatementAttachment,
  isCloudinaryConfigured,
} = require('../services/cloudinaryStatementUpload');

const MAX_STATEMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const LEGACY_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'card-statements');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif']);

function filenameFromPayload(payload, fallback = 'statement.pdf') {
  return String(
    payload.attachmentFilename ??
      payload.attachment_filename ??
      payload.statementPdfFilename ??
      payload.statement_pdf_filename ??
      payload.fileName ??
      payload.file_name ??
      payload.filename ??
      fallback
  )
    .trim()
    .slice(0, 512);
}

function extractInlineAttachmentRaw(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const directKeys = [
    'attachmentBase64',
    'attachment_base64',
    'statementPdfBase64',
    'statement_pdf_base64',
    'fileBase64',
    'file_base64',
    'pdfBase64',
    'pdf_base64',
    'base64',
    'dataUrl',
    'data_url',
  ];
  for (const key of directKeys) {
    const val = payload[key];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return { raw: val, filename: filenameFromPayload(payload) };
    }
  }

  const att = payload.attachment;
  if (typeof att === 'string' && att.trim()) {
    return { raw: att, filename: filenameFromPayload(payload) };
  }
  if (att && typeof att === 'object') {
    let raw =
      att.base64 ??
      att.data ??
      att.content ??
      att.file ??
      att.src;
    if (
      (raw === undefined || raw === null || String(raw).trim() === '') &&
      att.url &&
      /^data:/i.test(String(att.url))
    ) {
      raw = att.url;
    }
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      return {
        raw,
        filename: String(
          att.name ?? att.filename ?? att.fileName ?? filenameFromPayload(payload)
        )
          .trim()
          .slice(0, 512),
      };
    }
  }

  return null;
}

function resolveStagedStatementAttachment(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const staged =
    payload.stagedStatementAttachment ?? payload.staged_statement_attachment;
  if (!staged || typeof staged !== 'object') return null;
  const url = staged.url ?? staged.secure_url ?? staged.attachmentUrl;
  const publicId = staged.publicId ?? staged.public_id;
  if (!url || !publicId) return null;
  return {
    name: String(staged.name || staged.filename || 'statement.pdf').slice(0, 512),
    url: String(url),
    publicId: String(publicId),
    resourceType: staged.resourceType || staged.resource_type || 'raw',
  };
}

function payloadHasStatementAttachment(payload) {
  return Boolean(extractInlineAttachmentRaw(payload) || resolveStagedStatementAttachment(payload));
}

function detectAttachmentKind(buffer, filename, mimetypeFromDataUrl) {
  if (mimetypeFromDataUrl === 'application/pdf') return 'pdf';
  if (mimetypeFromDataUrl && mimetypeFromDataUrl.startsWith('image/')) return 'image';
  if (buffer.length >= 4 && buffer.slice(0, 4).toString() === '%PDF') return 'pdf';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image';
  }
  if (
    buffer.length >= 8 &&
    buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image';
  }
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return null;
}

function decodeStatementPdfBase64FromPayload(payload = {}) {
  const inline = extractInlineAttachmentRaw(payload);
  if (!inline) return null;

  const originalName = inline.filename || 'statement.pdf';
  let b64 = String(inline.raw).trim();
  let mimetypeFromDataUrl = null;
  const dataUrl = b64.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUrl) {
    mimetypeFromDataUrl = dataUrl[1].toLowerCase();
    b64 = dataUrl[2];
  }
  b64 = b64.replace(/\s/g, '');

  let buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch {
    return { error: 'Invalid attachment data: could not decode base64' };
  }
  if (!buffer.length) {
    return { error: 'Attachment decoded to empty data' };
  }
  if (buffer.length > MAX_STATEMENT_ATTACHMENT_BYTES) {
    return {
      error: `Statement attachment exceeds maximum size (${MAX_STATEMENT_ATTACHMENT_BYTES} bytes)`,
    };
  }

  const kind = detectAttachmentKind(buffer, originalName, mimetypeFromDataUrl);
  if (!kind) {
    return { error: 'Statement attachment must be a PDF or image (jpg, png, webp, gif)' };
  }

  let name = originalName;
  const ext = path.extname(name).toLowerCase();
  if (kind === 'pdf' && ext !== '.pdf') name = `${name.replace(/\.[^.]+$/, '')}.pdf`;
  if (kind === 'image' && !IMAGE_EXTENSIONS.has(ext) && ext !== '.pdf') {
    const suffix = mimetypeFromDataUrl?.includes('png') ? '.png' : '.jpg';
    name = `${name.replace(/\.[^.]+$/, '')}${suffix}`;
  }

  return { buffer, originalName: name, kind };
}

async function stageStatementAttachmentInPayload(payload, { requesterId } = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  if (resolveStagedStatementAttachment(payload)) return payload;
  if (!extractInlineAttachmentRaw(payload)) return payload;
  if (!isCloudinaryConfigured()) {
    throw new Error(
      'Cloudinary is not configured. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.'
    );
  }

  const decoded = decodeStatementPdfBase64FromPayload(payload);
  if (!decoded) return payload;
  if (decoded.error) throw new Error(decoded.error);

  const rid = Number(requesterId) || 'user';
  const pathSegment = `pending/${rid}/${randomUUID()}`;
  const resourceType = decoded.kind === 'image' ? 'image' : 'raw';
  const uploaded = await uploadStatementAttachment({
    buffer: decoded.buffer,
    pathSegment,
    originalFilename: decoded.originalName,
    resourceType,
  });

  const slim = { ...payload };
  const removeKeys = [
    'attachmentBase64',
    'attachment_base64',
    'statementPdfBase64',
    'statement_pdf_base64',
    'fileBase64',
    'file_base64',
    'pdfBase64',
    'pdf_base64',
    'base64',
    'dataUrl',
    'data_url',
    'attachment',
  ];
  for (const key of removeKeys) {
    delete slim[key];
  }

  slim.stagedStatementAttachment = {
    name: decoded.originalName,
    url: uploaded.secure_url,
    publicId: uploaded.public_id,
    resourceType,
  };
  return slim;
}

async function destroyStagedStatementAttachmentFromPayload(payload) {
  const staged = resolveStagedStatementAttachment(payload);
  if (!staged) return;
  await destroyStatementAttachment(staged.publicId, staged.resourceType);
}

async function saveStatementPdfAttachmentBuffer(statementId, buffer, originalName, existingRow, kind = 'pdf') {
  if (!buffer || buffer.length === 0) {
    return { ok: true };
  }
  if (!isCloudinaryConfigured()) {
    return {
      ok: false,
      status: 503,
      error:
        'Cloudinary is not configured. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.',
    };
  }

  const row = existingRow || (await Statement.getById(statementId));
  const prevCloudinaryId = row && row.attachment_cloudinary_public_id;
  const prevStorageKey = row && row.attachment_storage_key;
  const name = (originalName || 'statement.pdf').slice(0, 512);
  const resourceType = kind === 'image' ? 'image' : 'raw';

  let uploaded;
  try {
    uploaded = await uploadStatementAttachment({
      buffer,
      pathSegment: String(statementId),
      originalFilename: name,
      resourceType,
    });
  } catch (e) {
    console.error('Cloudinary statement attachment upload error:', e);
    return {
      ok: false,
      status: 502,
      error: e.message || 'Failed to upload attachment to Cloudinary',
    };
  }

  await Statement.update(statementId, {
    attachmentName: name,
    attachmentUrl: uploaded.secure_url,
    attachmentCloudinaryPublicId: uploaded.public_id,
    attachmentStorageKey: null,
  });

  if (prevCloudinaryId && prevCloudinaryId !== uploaded.public_id) {
    await destroyStatementAttachment(prevCloudinaryId, 'raw');
    await destroyStatementAttachment(prevCloudinaryId, 'image');
  }
  if (prevStorageKey) {
    const prevPath = path.join(LEGACY_UPLOAD_DIR, prevStorageKey);
    try {
      await fs.unlink(prevPath);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error('Failed to remove previous statement attachment:', e.message);
      }
    }
  }

  return { ok: true };
}

async function applyStatementAttachmentToRow(statementId, payload, existingRow) {
  const staged = resolveStagedStatementAttachment(payload);
  if (staged) {
    const row = existingRow || (await Statement.getById(statementId));
    const prevCloudinaryId = row && row.attachment_cloudinary_public_id;
    const prevStorageKey = row && row.attachment_storage_key;

    await Statement.update(statementId, {
      attachmentName: staged.name,
      attachmentUrl: staged.url,
      attachmentCloudinaryPublicId: staged.publicId,
      attachmentStorageKey: null,
    });

    if (prevCloudinaryId && prevCloudinaryId !== staged.publicId) {
      await destroyStatementAttachment(prevCloudinaryId, 'raw');
      await destroyStatementAttachment(prevCloudinaryId, 'image');
    }
    if (prevStorageKey) {
      const prevPath = path.join(LEGACY_UPLOAD_DIR, prevStorageKey);
      try {
        await fs.unlink(prevPath);
      } catch (e) {
        if (e.code !== 'ENOENT') console.error('Failed to remove legacy statement file:', e.message);
      }
    }
    return { ok: true };
  }

  const decoded = decodeStatementPdfBase64FromPayload(payload);
  if (!decoded) {
    return { ok: true };
  }
  if (decoded.error) {
    return { ok: false, error: decoded.error };
  }
  return saveStatementPdfAttachmentBuffer(
    statementId,
    decoded.buffer,
    decoded.originalName,
    existingRow,
    decoded.kind
  );
}

function buildChangeRequestAttachmentPreview(resourceType, payload) {
  if (resourceType !== 'card_statement' || !payload || typeof payload !== 'object') {
    return null;
  }

  const staged = resolveStagedStatementAttachment(payload);
  if (staged) {
    return {
      name: staged.name,
      url: staged.url,
      attachmentUrl: staged.url,
      type: staged.resourceType === 'image' ? 'image' : 'pdf',
      mimeType: staged.resourceType === 'image' ? null : 'application/pdf',
      source: 'staged',
    };
  }

  const inline = extractInlineAttachmentRaw(payload);
  if (!inline) return null;

  const raw = String(inline.raw).trim();
  if (/^data:/i.test(raw)) {
    const isPdf = /^data:application\/pdf/i.test(raw);
    return {
      name: inline.filename,
      url: raw,
      attachmentUrl: raw,
      type: isPdf ? 'pdf' : 'image',
      source: 'inline',
    };
  }

  return {
    name: inline.filename,
    hasInlineBase64: true,
    type: 'inline',
    source: 'inline',
  };
}

module.exports = {
  MAX_STATEMENT_ATTACHMENT_BYTES,
  payloadHasStatementAttachment,
  decodeStatementPdfBase64FromPayload,
  stageStatementAttachmentInPayload,
  destroyStagedStatementAttachmentFromPayload,
  saveStatementPdfAttachmentBuffer,
  applyStatementAttachmentToRow,
  buildChangeRequestAttachmentPreview,
};
