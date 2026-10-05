import { afterEach, describe, expect, it, vi } from 'vitest';
import { downscaleToJpeg, fitWithin, isDownscaledJpeg } from '@app/lib/image';

class FakeContext2D {
  fillStyle = '';
  imageSmoothingEnabled = false;
  imageSmoothingQuality = 'low';
  readonly ops: unknown[][] = [];
  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push(['fillRect', this.fillStyle, x, y, w, h]);
  }
  drawImage(image: unknown, x: number, y: number, w: number, h: number): void {
    this.ops.push(['drawImage', image, x, y, w, h]);
  }
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const photo = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x45, 0x78, 0x69, 0x66])], { type: 'image/jpeg' });

function stubBitmap(width: number, height: number, opts: { rejectOptions?: boolean } = {}) {
  const bitmap = { width, height, close: vi.fn() };
  const createImageBitmap = vi.fn(async (_image: Blob, options?: ImageBitmapOptions) => {
    if (options && opts.rejectOptions) throw new TypeError("The provided value 'from-image' is not a valid enum value.");
    return bitmap;
  });
  vi.stubGlobal('createImageBitmap', createImageBitmap);
  return { bitmap, createImageBitmap };
}

function stubOffscreenCanvas(opts: { no2d?: boolean } = {}) {
  const canvases: Array<{ width: number; height: number; ctx: FakeContext2D; options: unknown }> = [];
  class FakeOffscreenCanvas {
    readonly ctx = new FakeContext2D();
    options: unknown = null;
    constructor(
      readonly width: number,
      readonly height: number,
    ) {
      canvases.push(this);
    }
    getContext(kind: string): FakeContext2D | null {
      return kind === '2d' && !opts.no2d ? this.ctx : null;
    }
    async convertToBlob(options: { type: string; quality: number }): Promise<Blob> {
      this.options = options;
      return new Blob([JPEG], { type: options.type });
    }
  }
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  return canvases;
}

function stubDomCanvas(output: 'jpeg' | 'null' = 'jpeg') {
  const canvases: Array<{ width: number; height: number; ctx: FakeContext2D; toBlobArgs: unknown[] }> = [];
  class FakeCanvasElement {
    width = 0;
    height = 0;
    readonly ctx = new FakeContext2D();
    toBlobArgs: unknown[] = [];
    getContext(kind: string): FakeContext2D | null {
      return kind === '2d' ? this.ctx : null;
    }
    toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void {
      this.toBlobArgs = [type, quality];
      setTimeout(() => callback(output === 'jpeg' ? new Blob([JPEG], { type: 'image/jpeg' }) : null), 0);
    }
  }
  const createElement = vi.fn((_tag: string) => {
    const canvas = new FakeCanvasElement();
    canvases.push(canvas);
    return canvas;
  });
  vi.stubGlobal('document', { createElement });
  return { canvases, createElement };
}

/** <img> stand-in that "loads" asynchronously once src is set. */
function stubImageElement(size: { width: number; height: number } | 'error') {
  const images: FakeImage[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    private current = '';
    constructor() {
      images.push(this);
    }
    get src(): string {
      return this.current;
    }
    set src(value: string) {
      this.current = value;
      setTimeout(() => {
        if (size === 'error') {
          this.onerror?.();
          return;
        }
        this.naturalWidth = size.width;
        this.naturalHeight = size.height;
        this.onload?.();
      }, 0);
    }
  }
  vi.stubGlobal('Image', FakeImage);
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:receipt');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  return { images, createObjectURL, revokeObjectURL };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fitWithin', () => {
  it('fits the longest side and never upscales', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(1601, 1000, 1600)).toEqual({ width: 1600, height: 999 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1600, 1600, 1600)).toEqual({ width: 1600, height: 1600 });
    expect(fitWithin(5000, 2, 1600)).toEqual({ width: 1600, height: 1 });
  });
});

describe('downscaleToJpeg', () => {
  it('scales into maxSide, paints on white, and encodes JPEG at the given quality', async () => {
    const { bitmap, createImageBitmap } = stubBitmap(4000, 3000);
    const canvases = stubOffscreenCanvas();
    const input = photo();
    const output = await downscaleToJpeg(input, 1600, 0.85);

    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(createImageBitmap).toHaveBeenCalledWith(input, { imageOrientation: 'from-image' });
    expect(canvases).toHaveLength(1);
    const canvas = canvases[0];
    expect(canvas).toMatchObject({ width: 1600, height: 1200, options: { type: 'image/jpeg', quality: 0.85 } });
    expect(canvas?.ctx.ops).toEqual([
      ['fillRect', '#ffffff', 0, 0, 1600, 1200],
      ['drawImage', bitmap, 0, 0, 1600, 1200],
    ]);
    expect(canvas?.ctx.imageSmoothingQuality).toBe('high');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(output.type).toBe('image/jpeg');
    expect(Array.from(new Uint8Array(await output.arrayBuffer()))).toEqual(Array.from(JPEG));
    expect(isDownscaledJpeg(output)).toBe(true);
    expect(isDownscaledJpeg(input)).toBe(false);
  });

  it('re-encodes small pictures too (that is what strips EXIF), without upscaling', async () => {
    stubBitmap(800, 600);
    const canvases = stubOffscreenCanvas();
    await downscaleToJpeg(photo(), 1600, 0.7);
    expect(canvases[0]).toMatchObject({ width: 800, height: 600, options: { type: 'image/jpeg', quality: 0.7 } });
  });

  it('retries createImageBitmap without options when the engine rejects them', async () => {
    const { createImageBitmap } = stubBitmap(3000, 4000, { rejectOptions: true });
    const canvases = stubOffscreenCanvas();
    await downscaleToJpeg(photo(), 1600, 0.85);
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    expect(createImageBitmap.mock.calls[1]?.[1]).toBeUndefined();
    expect(canvases[0]).toMatchObject({ width: 1200, height: 1600 });
  });

  it('uses a DOM canvas when there is no OffscreenCanvas', async () => {
    const { bitmap } = stubBitmap(2000, 1000);
    const { canvases, createElement } = stubDomCanvas();
    const output = await downscaleToJpeg(photo(), 1600, 0.85);
    expect(createElement).toHaveBeenCalledWith('canvas');
    expect(canvases[0]).toMatchObject({ width: 1600, height: 800, toBlobArgs: ['image/jpeg', 0.85] });
    expect(canvases[0]?.ctx.ops).toEqual([
      ['fillRect', '#ffffff', 0, 0, 1600, 800],
      ['drawImage', bitmap, 0, 0, 1600, 800],
    ]);
    expect(output.type).toBe('image/jpeg');
    expect(isDownscaledJpeg(output)).toBe(true);
  });

  it('uses a DOM canvas when OffscreenCanvas has no 2D context', async () => {
    stubBitmap(1000, 1000);
    stubOffscreenCanvas({ no2d: true });
    const { canvases } = stubDomCanvas();
    await downscaleToJpeg(photo(), 1600, 0.85);
    expect(canvases).toHaveLength(1);
  });

  it('falls back to an <img> element without createImageBitmap', async () => {
    const { images, createObjectURL, revokeObjectURL } = stubImageElement({ width: 3200, height: 1600 });
    const canvases = stubOffscreenCanvas();
    const input = photo();
    await downscaleToJpeg(input, 1600, 0.85);
    expect(createObjectURL).toHaveBeenCalledWith(input);
    expect(images[0]?.src).toBe('blob:receipt');
    expect(canvases[0]).toMatchObject({ width: 1600, height: 800 });
    expect(canvases[0]?.ctx.ops[1]).toEqual(['drawImage', images[0], 0, 0, 1600, 800]);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:receipt');
  });

  it('rejects when the <img> cannot decode the file, and revokes the URL', async () => {
    const { revokeObjectURL } = stubImageElement('error');
    stubOffscreenCanvas();
    await expect(downscaleToJpeg(photo(), 1600, 0.85)).rejects.toThrow(/could not decode/);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:receipt');
  });

  it('rejects when nothing here can decode pictures (e.g. Node)', async () => {
    await expect(downscaleToJpeg(photo(), 1600, 0.85)).rejects.toThrow(/no image decoder/);
  });

  it('rejects when the canvas cannot encode, and still closes the bitmap', async () => {
    const { bitmap } = stubBitmap(100, 100);
    stubDomCanvas('null');
    await expect(downscaleToJpeg(photo(), 1600, 0.85)).rejects.toThrow(/JPEG/);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-positive maxSide', async () => {
    await expect(downscaleToJpeg(photo(), 0, 0.85)).rejects.toThrow(RangeError);
  });
});
