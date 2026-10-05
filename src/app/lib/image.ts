/**
 * Receipt photo preparation (docs/SPEC.md §7.3; interface frozen by §7.6).
 *
 * Every picture is re-encoded through a canvas, even when it is already small: that bounds the
 * upload, applies the EXIF orientation, and drops EXIF itself (location, device) before anything
 * leaves the device. Decoders and canvases are feature-detected inside functions so the module
 * imports cleanly in Node.
 */

const prepared = new WeakSet<Blob>();

/** True for blobs produced by downscaleToJpeg, so callers can skip a second, lossy pass. */
export function isDownscaledJpeg(blob: Blob): boolean {
  return prepared.has(blob);
}

/** Size whose longest side is ≤ maxSide (never upscaled, at least 1×1). */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

type Decoded = { source: CanvasImageSource; width: number; height: number; release(): void };
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

async function decodeWithBitmap(file: Blob): Promise<Decoded | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Engines that do not know the option reject the whole call; retry with their default orientation.
  }
  if (!bitmap) {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return null;
    }
  }
  const image = bitmap;
  return { source: image, width: image.width, height: image.height, release: () => image.close() };
}

// Last resort for engines without createImageBitmap (or that cannot decode this file with it).
function decodeWithElement(file: Blob): Promise<Decoded> {
  return new Promise<Decoded>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Cannot read the picture: the browser could not decode it.'));
    };
    img.src = url;
  });
}

async function decodeImage(file: Blob): Promise<Decoded> {
  const bitmap = await decodeWithBitmap(file);
  if (bitmap) return bitmap;
  if (typeof Image !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    return decodeWithElement(file);
  }
  throw new Error('Cannot read the picture: this environment has no image decoder.');
}

function paint(ctx: Context2D, source: CanvasImageSource, width: number, height: number): void {
  // JPEG has no alpha: transparent regions (screenshots, PNGs) would otherwise turn black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
}

async function encodeOffscreen(source: CanvasImageSource, width: number, height: number, quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    paint(ctx, source, width, height);
    return await canvas.convertToBlob({ type: 'image/jpeg', quality });
  } catch {
    // Some Safari versions ship OffscreenCanvas without a working 2D context: use a DOM canvas.
    return null;
  }
}

function encodeElement(source: CanvasImageSource, width: number, height: number, quality: number): Promise<Blob> {
  if (typeof document === 'undefined') return Promise.reject(new Error('Cannot draw the picture: this environment has no canvas.'));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Cannot draw the picture: no 2D canvas.'));
  paint(ctx, source, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Cannot encode the picture as JPEG.'))), 'image/jpeg', quality);
  });
}

/** Decodes (honouring EXIF orientation), fits the longest side into maxSide, and re-encodes as JPEG on white. */
export async function downscaleToJpeg(file: Blob, maxSide: number, quality: number): Promise<Blob> {
  if (!(maxSide > 0)) throw new RangeError(`maxSide must be positive, got ${maxSide}`);
  const image = await decodeImage(file);
  try {
    if (!(image.width > 0 && image.height > 0)) throw new Error('Cannot read the picture: it has no pixels.');
    const { width, height } = fitWithin(image.width, image.height, maxSide);
    const blob = (await encodeOffscreen(image.source, width, height, quality)) ?? (await encodeElement(image.source, width, height, quality));
    prepared.add(blob);
    return blob;
  } finally {
    image.release();
  }
}
