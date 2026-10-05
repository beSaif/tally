import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEVEL_BARS, RECORDER_MIME_TYPES, blobToWav16k, bucketLevels, encodeWav, mixToMono, pickMimeType, resampleLinear } from '@app/lib/audio';

function ascii(view: DataView, offset: number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
}

function pcmSamples(buffer: ArrayBuffer): number[] {
  const view = new DataView(buffer);
  return Array.from({ length: (buffer.byteLength - 44) / 2 }, (_, i) => view.getInt16(44 + 2 * i, true));
}

type FakeBuffer = { numberOfChannels: number; sampleRate: number; length: number; getChannelData(channel: number): Float32Array };

function fakeBuffer(channels: number[][], sampleRate: number): FakeBuffer {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0]?.length ?? 0,
    getChannelData: (channel: number) => Float32Array.from(channels[channel] ?? []),
  };
}

/** AudioContext stand-in; `decode` decides what decodeAudioData does. */
function stubAudioContext(decode: (bytes: ArrayBuffer, ok?: (buffer: FakeBuffer) => void) => Promise<FakeBuffer> | undefined) {
  const contexts: Array<{ closed: boolean; bytes: number }> = [];
  class FakeAudioContext {
    state = 'running';
    closed = false;
    bytes = 0;
    constructor() {
      contexts.push(this);
    }
    decodeAudioData(bytes: ArrayBuffer, ok?: (buffer: FakeBuffer) => void): Promise<FakeBuffer> | undefined {
      this.bytes = bytes.byteLength;
      return decode(bytes, ok);
    }
    async close(): Promise<void> {
      this.closed = true;
      this.state = 'closed';
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  return contexts;
}

const recording = () => new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])], { type: 'audio/webm;codecs=opus' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('encodeWav', () => {
  it('writes the exact 44-byte RIFF/WAVE PCM header', () => {
    const header = Array.from(new Uint8Array(encodeWav(new Float32Array(2), 16_000), 0, 44));
    expect(header).toEqual([
      0x52, 0x49, 0x46, 0x46, 40, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, // "RIFF", 36 + data size, "WAVE"
      0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 1, 0, // "fmt ", chunk size 16, PCM, mono
      0x80, 0x3e, 0, 0, 0x00, 0x7d, 0, 0, 2, 0, 16, 0, // 16000 Hz, 32000 bytes/s, block align 2, 16 bits
      0x64, 0x61, 0x74, 0x61, 4, 0, 0, 0, // "data", 2 samples × 2 bytes
    ]);
  });

  it('sizes the chunks for any length and rate', () => {
    const buffer = encodeWav(new Float32Array(1000), 44_100);
    const view = new DataView(buffer);
    expect(buffer.byteLength).toBe(44 + 2000);
    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 2000);
    expect(ascii(view, 8, 8)).toBe('WAVEfmt ');
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint32(28, true)).toBe(88_200);
    expect(ascii(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(2000);
  });

  it('encodes an empty recording as a bare header', () => {
    const buffer = encodeWav(new Float32Array(0), 16_000);
    const view = new DataView(buffer);
    expect(buffer.byteLength).toBe(44);
    expect(view.getUint32(4, true)).toBe(36);
    expect(view.getUint32(40, true)).toBe(0);
  });

  it('scales samples to int16, clamps to [-1, 1] and writes little-endian', () => {
    const buffer = encodeWav(Float32Array.from([0, 1, -1, 0.5, -0.5, 2, -2, Number.NaN, 0.25]), 16_000);
    expect(pcmSamples(buffer)).toEqual([0, 32767, -32768, 16384, -16384, 32767, -32768, 0, 8192]);
    expect(Array.from(new Uint8Array(buffer, 46, 4))).toEqual([0xff, 0x7f, 0x00, 0x80]);
  });

  it.each([0, -16_000, 1.5, Number.NaN])('rejects the sample rate %s', (rate) => {
    expect(() => encodeWav(new Float32Array(1), rate)).toThrow(RangeError);
  });
});

describe('mixToMono', () => {
  it('averages the channels', () => {
    expect(Array.from(mixToMono([Float32Array.from([1, 0.5, -1]), Float32Array.from([0, 0.5, 1])]))).toEqual([0.5, 0.5, 0]);
  });

  it('is bounded by the shortest channel, passes mono through and handles no channels', () => {
    expect(mixToMono([Float32Array.from([1, 1, 1]), Float32Array.from([1, 1])])).toHaveLength(2);
    const mono = Float32Array.from([0.1, 0.2]);
    expect(mixToMono([mono])).toBe(mono);
    expect(mixToMono([])).toHaveLength(0);
  });
});

describe('resampleLinear', () => {
  it('downsamples', () => {
    expect(Array.from(resampleLinear(Float32Array.from([0, 1, 2, 3, 4, 5]), 48_000, 16_000))).toEqual([0, 3]);
    expect(resampleLinear(new Float32Array(44_100), 44_100, 16_000)).toHaveLength(16_000);
  });

  it('upsamples by interpolating, holding the last sample', () => {
    expect(Array.from(resampleLinear(Float32Array.from([0, 1, 2]), 8_000, 16_000))).toEqual([0, 0.5, 1, 1.5, 2, 2]);
  });

  it('copies when the rate already matches, and rejects bad rates', () => {
    const samples = Float32Array.from([0.25, -0.25]);
    const copy = resampleLinear(samples, 16_000, 16_000);
    expect(copy).not.toBe(samples);
    expect(Array.from(copy)).toEqual([0.25, -0.25]);
    expect(() => resampleLinear(samples, 0, 16_000)).toThrow(RangeError);
  });
});

describe('bucketLevels', () => {
  it('returns one value in 0..1 per bar', () => {
    const bins = Uint8Array.from({ length: 128 }, (_, i) => (i * 37) % 256);
    const levels = bucketLevels(bins);
    expect(levels).toBeInstanceOf(Float32Array);
    expect(levels).toHaveLength(LEVEL_BARS);
    expect(LEVEL_BARS).toBe(46);
    for (const level of levels) {
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(1);
    }
  });

  it('maps full scale to 1 and silence to 0', () => {
    expect(Array.from(bucketLevels(new Uint8Array(128).fill(255)))).toEqual(new Array(46).fill(1));
    expect(Array.from(bucketLevels(new Uint8Array(128)))).toEqual(new Array(46).fill(0));
  });

  it('averages each bucket and shares bins when there are fewer bins than bars', () => {
    expect(Array.from(bucketLevels(Uint8Array.from([0, 255, 255, 0]), 2))).toEqual([0.5, 0.5]);
    const shared = Array.from(bucketLevels(Uint8Array.from([255, 0, 51]), 6), (v) => Number(v.toFixed(4)));
    expect(shared).toEqual([1, 1, 0, 0, 0.2, 0.2]);
  });

  it('only looks at the requested bin range', () => {
    expect(Array.from(bucketLevels(Uint8Array.from([255, 0, 0, 255]), 2, 1, 3))).toEqual([0, 0]);
  });
});

describe('pickMimeType', () => {
  it('follows the §7.3 preference order', () => {
    expect(RECORDER_MIME_TYPES).toEqual(['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus']);
    expect(pickMimeType(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickMimeType((t) => t !== 'audio/webm;codecs=opus')).toBe('audio/mp4');
    expect(pickMimeType((t) => t === 'audio/ogg;codecs=opus')).toBe('audio/ogg;codecs=opus');
  });

  it('falls back to the browser default', () => {
    expect(pickMimeType(() => false)).toBe('');
    expect(
      pickMimeType(() => {
        throw new Error('probe failed');
      }),
    ).toBe('');
  });
});

describe('blobToWav16k', () => {
  it('rejects with a clear error where there is no AudioContext (e.g. Node)', async () => {
    await expect(blobToWav16k(recording())).rejects.toThrow(/AudioContext/);
  });

  it('decodes, downmixes and resamples to 16 kHz (interpolation fallback), then closes the context', async () => {
    const contexts = stubAudioContext(async () =>
      fakeBuffer(
        [
          [0.5, 0.5, 0.5, 1, 1, 1],
          [0.25, 0.25, 0.25, -1, -1, -1],
        ],
        48_000,
      ),
    );
    const wav = await blobToWav16k(recording());
    expect(wav.type).toBe('audio/wav');
    const buffer = await wav.arrayBuffer();
    const view = new DataView(buffer);
    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(pcmSamples(buffer)).toEqual([12288, 0]); // mono (0.375, 0) at a third of the rate
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ closed: true, bytes: 8 });
  });

  it('resamples with an OfflineAudioContext when one is available', async () => {
    stubAudioContext(async () => fakeBuffer([[0.5, 0.5, 0.5, 1, 1, 1]], 48_000));
    const rendered = Float32Array.from([0.25, -0.25]);
    const created: Array<{ args: number[]; input: Float32Array | null; started: boolean }> = [];
    class FakeOfflineAudioContext {
      readonly destination = {};
      readonly record: { args: number[]; input: Float32Array | null; started: boolean };
      oncomplete: unknown = null;
      constructor(channels: number, length: number, sampleRate: number) {
        this.record = { args: [channels, length, sampleRate], input: null, started: false };
        created.push(this.record);
      }
      createBuffer(_channels: number, length: number, _sampleRate: number) {
        const data = new Float32Array(length);
        this.record.input = data;
        return { getChannelData: () => data };
      }
      createBufferSource() {
        return { buffer: null, connect: vi.fn(), start: () => (this.record.started = true) };
      }
      async startRendering() {
        return { getChannelData: () => rendered };
      }
    }
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
    const buffer = await (await blobToWav16k(recording())).arrayBuffer();
    expect(created).toHaveLength(1);
    expect(created[0]?.args).toEqual([1, 2, 16_000]);
    expect(Array.from(created[0]?.input ?? [])).toEqual([0.5, 0.5, 0.5, 1, 1, 1]);
    expect(created[0]?.started).toBe(true);
    expect(pcmSamples(buffer)).toEqual([8192, -8192]);
  });

  it('falls back to interpolation when the OfflineAudioContext refuses 16 kHz', async () => {
    stubAudioContext(async () => fakeBuffer([[0.5, 0.5, 0.5, 0, 0, 0]], 48_000));
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        constructor() {
          throw new DOMException('sampleRate out of range', 'NotSupportedError');
        }
      },
    );
    expect(pcmSamples(await (await blobToWav16k(recording())).arrayBuffer())).toEqual([16384, 0]);
  });

  it('keeps 16 kHz mono as is', async () => {
    stubAudioContext(async () => fakeBuffer([[0.5, -0.5, 0.25]], 16_000));
    expect(pcmSamples(await (await blobToWav16k(recording())).arrayBuffer())).toEqual([16384, -16384, 8192]);
  });

  it('supports the callback-only decodeAudioData of old WebKit', async () => {
    stubAudioContext((_bytes, ok) => {
      setTimeout(() => ok?.(fakeBuffer([[1]], 16_000)), 0);
      return undefined;
    });
    expect(pcmSamples(await (await blobToWav16k(recording())).arrayBuffer())).toEqual([32767]);
  });

  it('throws a descriptive error when decoding fails, and still closes the context', async () => {
    const contexts = stubAudioContext(async () => {
      throw new DOMException('Unable to decode audio data', 'EncodingError');
    });
    await expect(blobToWav16k(recording())).rejects.toThrow('Cannot decode the recording (audio/webm;codecs=opus): Unable to decode audio data');
    expect(contexts[0]?.closed).toBe(true);
  });

  it('rejects an empty recording without creating a context', async () => {
    const contexts = stubAudioContext(async () => fakeBuffer([[0]], 16_000));
    await expect(blobToWav16k(new Blob([], { type: 'audio/webm' }))).rejects.toThrow(/empty/);
    expect(contexts).toHaveLength(0);
  });
});
