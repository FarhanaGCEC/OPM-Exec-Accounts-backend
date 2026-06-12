const { cloudinary, isCloudinaryConfigured } = require('../config/cloudinary');

function inferCloudinaryResourceType({ name, url, explicitType }) {
  if (explicitType === 'image' || explicitType === 'raw') return explicitType;
  const candidate = `${name || ''} ${url || ''}`.toLowerCase();
  if (candidate.includes('/raw/upload/') || /\.pdf($|\?)/i.test(candidate)) {
    return 'raw';
  }
  if (candidate.includes('/image/upload/')) {
    return 'image';
  }
  return /\.pdf($|\?)/i.test(candidate) ? 'raw' : 'image';
}

/**
 * Stream a Cloudinary attachment through the API (avoids raw PDF 401 in browser).
 */
async function streamCloudinaryAttachmentResponse(
  res,
  { publicId, resourceType, filename, fallbackContentType = 'application/octet-stream' }
) {
  if (!isCloudinaryConfigured() || !publicId) {
    return { ok: false, status: 503, error: 'Cloudinary is not configured for this attachment' };
  }

  const rt = resourceType === 'raw' ? 'raw' : 'image';
  let signedUrl;
  try {
    signedUrl = cloudinary.utils.private_download_url(publicId, '', {
      resource_type: rt,
      type: 'upload',
      expires_at: Math.floor(Date.now() / 1000) + 600,
    });
  } catch (e) {
    console.error('Cloudinary private_download_url error:', e);
    return { ok: false, status: 502, error: 'Failed to sign Cloudinary download URL' };
  }

  let upstream;
  try {
    upstream = await fetch(signedUrl);
  } catch (e) {
    console.error('Cloudinary attachment fetch error:', e);
    return { ok: false, status: 502, error: 'Failed to retrieve attachment from Cloudinary' };
  }

  if (!upstream.ok) {
    const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
    return {
      ok: false,
      status,
      error: `Cloudinary returned ${upstream.status} fetching attachment`,
    };
  }

  const safeName = (filename || 'attachment').replace(/"/g, '');
  res.setHeader('Content-Type', upstream.headers.get('content-type') || fallbackContentType);
  const upstreamLen = upstream.headers.get('content-length');
  if (upstreamLen) res.setHeader('Content-Length', upstreamLen);
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');

  if (!upstream.body) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
    return { ok: true };
  }

  const reader = upstream.body.getReader();
  res.on('close', () => {
    try {
      reader.cancel();
    } catch (_) {
      /* ignore */
    }
  });
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(Buffer.from(value))) {
      await new Promise((resolve) => res.once('drain', resolve));
    }
  }
  res.end();
  return { ok: true };
}

module.exports = {
  inferCloudinaryResourceType,
  streamCloudinaryAttachmentResponse,
};
