const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const Tesseract = require('tesseract.js');

let pdfjsPromise = null;
let tesseractWorkerPromise = null;

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = path.join(
        process.cwd(),
        'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'
      );
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

async function getTesseractWorker() {
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = Tesseract.createWorker('eng');
  }
  return tesseractWorkerPromise;
}

/**
 * Render PDF page 1 to PNG buffer (Node).
 * @param {Buffer} pdfBuffer
 * @param {{ scale?: number }} [opts]
 * @returns {Promise<Buffer|null>}
 */
async function renderPdfFirstPagePng(pdfBuffer, opts = {}) {
  const scale = opts.scale || 2;
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(pdfBuffer);

  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toBuffer('image/png');
  } finally {
    try {
      if (typeof doc.destroy === 'function') await doc.destroy();
      else if (typeof doc.cleanup === 'function') doc.cleanup();
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * Invert / grayscale PNG — helps ADCB white-on-dark table headers.
 * @param {Buffer} pngBuffer
 * @returns {Promise<Buffer>}
 */
async function invertPngBuffer(pngBuffer) {
  const img = await loadImage(pngBuffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = 255 - g;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toBuffer('image/png');
}

/**
 * OCR an image buffer (png/jpeg) to plain text.
 * @param {Buffer} imageBuffer
 * @returns {Promise<string>}
 */
async function ocrImageBuffer(imageBuffer) {
  const worker = await getTesseractWorker();
  const {
    data: { text },
  } = await worker.recognize(imageBuffer);
  return text || '';
}

/**
 * OCR first page of a PDF → text.
 * Tries scale 2, then 2.5, and merges inverted OCR for dark-header banks (ADCB).
 * @param {Buffer} pdfBuffer
 * @returns {Promise<string>}
 */
async function ocrPdfFirstPage(pdfBuffer) {
  const png = await renderPdfFirstPagePng(pdfBuffer, { scale: 2 });
  if (!png || !png.length) return '';
  let text = await ocrImageBuffer(png);

  const hasAvailLabel =
    /avai\w{0,8}\s*cred|available\s*limit|الحد\s*المتوف|total\s*credit\s*limi/i.test(
      text || ''
    );
  if (!hasAvailLabel || String(text || '').trim().length < 80) {
    try {
      const pngHi = await renderPdfFirstPagePng(pdfBuffer, { scale: 2.5 });
      if (pngHi && pngHi.length) {
        const hiText = await ocrImageBuffer(pngHi);
        if (
          String(hiText || '').length > String(text || '').length ||
          (/available\s*cred|avaibble\s*cred|available\s*limit|total\s*credit\s*limi/i.test(
            hiText
          ) &&
            !/available\s*cred|avaibble\s*cred|available\s*limit|total\s*credit\s*limi/i.test(
              text || ''
            ))
        ) {
          text = hiText;
        }
      }
    } catch (err) {
      console.warn('[STATEMENT] OCR hi-res retry failed:', err.message);
    }
  }

  // ADCB / dark headers: merge inverted OCR so amount pairs after Total Credit Limit are clear
  const needsInvert =
    /adcb|lulu|total\s*credit\s*limi|total\s*outstanding/i.test(text || '') ||
    !/available\s*cred(?:it)?\s*limit/i.test(text || '');
  if (needsInvert) {
    try {
      const basePng =
        (await renderPdfFirstPagePng(pdfBuffer, { scale: 2.5 })) || png;
      const inverted = await invertPngBuffer(basePng);
      const invText = await ocrImageBuffer(inverted);
      if (invText && invText.trim()) {
        text = `${text}\n${invText}`;
      }
    } catch (err) {
      console.warn('[STATEMENT] OCR invert pass failed:', err.message);
    }
  }

  return text || '';
}

async function terminateOcrWorker() {
  if (!tesseractWorkerPromise) return;
  try {
    const worker = await tesseractWorkerPromise;
    await worker.terminate();
  } catch (_) {
    /* ignore */
  }
  tesseractWorkerPromise = null;
}

module.exports = {
  renderPdfFirstPagePng,
  invertPngBuffer,
  ocrImageBuffer,
  ocrPdfFirstPage,
  terminateOcrWorker,
};
