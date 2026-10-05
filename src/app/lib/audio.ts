/**
 * Microphone recording + WAV re-encoding (docs/SPEC.md §7.3; interface frozen by §7.6).
 *
 * Browser audio APIs are feature-detected inside functions, never at module top level, so this
 * module imports cleanly in Node (unit tests) and in browsers that lack some of them.
 */

/** Gemini reads 16 kHz mono speech well, and a 60 s note stays under 2 MB. */
export const WAV_SAMPLE_RATE = 16_000;
/** Number of bars the capture sheet draws (design A.2). */
export const LEVEL_BARS = 46;
/** Preferred MediaRecorder formats, best first (§7.3); none supported → the browser default. */
export const RECORDER_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'] as const;

const TIMESLICE_MS = 250;
const FFT_SIZE = 256;
/** Upper edge of the band the waveform shows: speech has little energy above it. */
const LEVELS_MAX_HZ = 9_000;
/** Some engines never fire `stop` when the track died first; the UI must not hang on them. */
const STOP_TIMEOUT_MS = 3_000;

type AudioContextCtor = new () => AudioContext;
type OfflineAudioContextCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

// Older Safari only ships the prefixed constructors.
function audioContextCtor(): AudioContextCtor | undefined {
  const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext;
}

function offlineAudioContextCtor(): OfflineAudioContextCtor | undefined {
  const g = globalThis as { OfflineAudioContext?: OfflineAudioContextCtor; webkitOfflineAudioContext?: OfflineAudioContextCtor };
  return g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
}

function namedError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === 'string' ? err : 'unknown error';
}

/** Best-effort call (close, resume) that may throw, reject, or — in old WebKit — return nothing. */
function quietly(run: () => unknown): void {
  try {
    const result = run();
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // Nothing useful to do: the caller is already cleaning up.
  }
}

function closeAudio(ctx: AudioContext): void {
  if (ctx.state !== 'closed') quietly(() => ctx.close());
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) quietly(() => track.stop());
}

/** First of RECORDER_MIME_TYPES the engine supports, or '' for the browser default. */
export function pickMimeType(isTypeSupported: (type: string) => boolean): string {
  for (const type of RECORDER_MIME_TYPES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // A throwing probe means "not supported" for that type.
    }
  }
  return '';
}

/**
 * Buckets analyser bins [from, to) into `bars` levels in 0..1 (average of each bucket).
 * When there are fewer bins than bars, neighbouring bars share a bin.
 */
export function bucketLevels(bins: ArrayLike<number>, bars: number = LEVEL_BARS, from = 0, to: number = bins.length): Float32Array {
  const levels = new Float32Array(bars);
  const start = Math.max(0, Math.min(from, bins.length));
  const end = Math.max(start, Math.min(to, bins.length));
  const span = end - start;
  if (span === 0) return levels;
  for (let bar = 0; bar < bars; bar++) {
    const lo = start + Math.floor((bar * span) / bars);
    const hi = Math.max(lo + 1, start + Math.floor(((bar + 1) * span) / bars));
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += bins[i] ?? 0;
    levels[bar] = Math.min(1, Math.max(0, sum / (hi - lo) / 255));
  }
  return levels;
}

/** Bins worth showing: skip DC, stop around LEVELS_MAX_HZ, but keep at least one bin per bar. */
function voiceBand(sampleRate: number, binCount: number): { from: number; to: number } {
  const binHz = sampleRate / FFT_SIZE;
  const wanted = Number.isFinite(binHz) && binHz > 0 ? Math.round(LEVELS_MAX_HZ / binHz) : binCount;
  return { from: 1, to: Math.min(binCount, 1 + Math.max(LEVEL_BARS, wanted)) };
}

type FrameHandle = { cancel(): void };

function scheduleFrame(callback: () => void): FrameHandle {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(callback);
    return { cancel: () => cancelAnimationFrame(id) };
  }
  const id = setTimeout(callback, 16);
  return { cancel: () => clearTimeout(id) };
}

function createAudioContext(): AudioContext | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

function createMediaRecorder(stream: MediaStream): MediaRecorder {
  const probe = typeof MediaRecorder.isTypeSupported === 'function' ? (type: string) => MediaRecorder.isTypeSupported(type) : () => false;
  const mimeType = pickMimeType(probe);
  if (mimeType) {
    try {
      return new MediaRecorder(stream, { mimeType });
    } catch {
      // isTypeSupported said yes but the constructor disagrees: use the browser default instead.
    }
  }
  return new MediaRecorder(stream);
}

type Session = {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  audio: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  frame: FrameHandle | null;
};

/** Feeds the waveform. Purely cosmetic, so any failure leaves the recording itself untouched. */
function wireLevels(session: Session, onLevel: (levels: Float32Array) => void): void {
  const audio = session.audio;
  if (!audio) return;
  try {
    const source = audio.createMediaStreamSource(session.stream);
    const analyser = audio.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    // Not connected to the destination: the person must not hear themselves.
    source.connect(analyser);
    session.source = source;
    if (audio.state === 'suspended') quietly(() => audio.resume());
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const band = voiceBand(audio.sampleRate, analyser.frequencyBinCount);
    const tick = (): void => {
      if (!session.frame) return;
      // Scheduled before the callback so an exception in the UI does not freeze the waveform.
      session.frame = scheduleFrame(tick);
      analyser.getByteFrequencyData(bins);
      onLevel(bucketLevels(bins, LEVEL_BARS, band.from, band.to));
    };
    session.frame = scheduleFrame(tick);
  } catch {
    session.frame?.cancel();
    session.frame = null;
  }
}

/** Records with MediaRecorder and reports live levels (0..1 per bar) for the waveform. */
export class Recorder {
  private mime = '';
  private session: Session | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<Blob> | null = null;
  private rejectStop: ((err: Error) => void) | null = null;
  /** Bumped by cancel() so a start() still waiting for permission knows to give up. */
  private generation = 0;

  /** Container of the current or last recording ('' until a recording has started). */
  get mimeType(): string {
    return this.mime;
  }

  /**
   * Asks for the microphone and starts recording. getUserMedia errors are rethrown as they are, so
   * their `name` (NotAllowedError, NotFoundError, …) reaches the UI; no recording support →
   * NotSupportedError; cancel() before permission was granted → AbortError.
   */
  async start(onLevel: (levels: Float32Array) => void): Promise<void> {
    if (this.starting || this.session) throw namedError('InvalidStateError', 'The recorder is already running.');
    const generation = ++this.generation;
    // Created before the first await so it is born inside the caller's pointer gesture;
    // otherwise autoplay rules may keep it suspended and the waveform stays flat.
    const audio = createAudioContext();
    const run = this.open(onLevel, generation, audio);
    this.starting = run;
    try {
      await run;
    } finally {
      if (this.starting === run) this.starting = null;
    }
  }

  private async open(onLevel: (levels: Float32Array) => void, generation: number, audio: AudioContext | null): Promise<void> {
    let owned = false;
    try {
      const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
      if (!devices || typeof devices.getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') {
        throw namedError('NotSupportedError', 'This browser cannot record audio.');
      }
      let stream: MediaStream;
      try {
        stream = await devices.getUserMedia({ audio: true });
      } catch (err) {
        throw err instanceof Error ? err : namedError('NotAllowedError', errorText(err));
      }
      if (generation !== this.generation) {
        stopStream(stream);
        throw namedError('AbortError', 'The recording was cancelled.');
      }
      const chunks: Blob[] = [];
      let recorder: MediaRecorder;
      try {
        recorder = createMediaRecorder(stream);
        recorder.addEventListener('dataavailable', (event: BlobEvent) => {
          if (event.data && event.data.size > 0) chunks.push(event.data);
        });
        recorder.start(TIMESLICE_MS);
      } catch (err) {
        stopStream(stream);
        throw err instanceof Error ? err : namedError('NotSupportedError', errorText(err));
      }
      this.mime = recorder.mimeType;
      const session: Session = { stream, recorder, chunks, audio, source: null, frame: null };
      this.session = session;
      owned = true;
      wireLevels(session, onLevel);
    } finally {
      if (!owned && audio) closeAudio(audio);
    }
  }

  /** Stops and resolves with everything recorded (type = the recorder's mimeType); the microphone is released. */
  async stop(): Promise<Blob> {
    // stop() may arrive while permission is still pending (a quick release): finish starting first.
    if (this.starting) await this.starting;
    if (this.stopping) return this.stopping;
    const session = this.session;
    if (!session) throw namedError('InvalidStateError', 'The recorder is not recording.');
    const run = this.finish(session);
    this.stopping = run;
    try {
      return await run;
    } finally {
      if (this.stopping === run) this.stopping = null;
    }
  }

  private finish(session: Session): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      const { recorder } = session;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        recorder.removeEventListener('stop', done);
        if (this.rejectStop !== reject) return; // cancel() won the race
        this.rejectStop = null;
        const type = recorder.mimeType || session.chunks[0]?.type || this.mime;
        if (type) this.mime = type;
        this.release(session);
        resolve(new Blob(session.chunks, type ? { type } : {}));
      };
      this.rejectStop = reject;
      if (recorder.state === 'inactive') {
        done();
        return;
      }
      recorder.addEventListener('stop', done);
      timer = setTimeout(done, STOP_TIMEOUT_MS);
      try {
        recorder.stop();
      } catch {
        done();
      }
    });
  }

  /** Stops everything without producing a blob; a pending stop() rejects with AbortError. Safe to call anytime. */
  cancel(): void {
    this.generation++;
    const reject = this.rejectStop;
    this.rejectStop = null;
    const session = this.session;
    if (session) {
      if (session.recorder.state !== 'inactive') quietly(() => session.recorder.stop());
      this.release(session);
    }
    reject?.(namedError('AbortError', 'The recording was cancelled.'));
  }

  private release(session: Session): void {
    if (this.session === session) this.session = null;
    session.frame?.cancel();
    session.frame = null;
    const source = session.source;
    if (source) quietly(() => source.disconnect());
    session.source = null;
    if (session.audio) closeAudio(session.audio);
    session.audio = null;
    stopStream(session.stream);
  }
}

// Old WebKit reports decodeAudioData only through callbacks; modern engines also return a promise.
function decodeAudio(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    const pending: Promise<AudioBuffer> | undefined = ctx.decodeAudioData(bytes, resolve, (err) => reject(err ?? new Error('decodeAudioData failed')));
    if (pending && typeof pending.then === 'function') pending.then(resolve, reject);
  });
}

// Same story for startRendering: a promise in modern engines, the `complete` event in old WebKit.
function renderOffline(ctx: OfflineAudioContext): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    ctx.oncomplete = (event) => resolve(event.renderedBuffer);
    const pending: Promise<AudioBuffer> | undefined = ctx.startRendering();
    if (pending && typeof pending.then === 'function') pending.then(resolve, reject);
  });
}

/** Average of all channels (the shortest channel bounds the length). */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  let length = first.length;
  for (const channel of channels) length = Math.min(length, channel.length);
  const out = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) + (channel[i] ?? 0);
  }
  for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) / channels.length;
  return out;
}

/** Linear-interpolation resampler: the fallback when no OfflineAudioContext accepts the target rate. */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError(`Invalid sample rates: ${fromRate} → ${toRate}`);
  if (fromRate === toRate) return samples.slice();
  const length = Math.round((samples.length * toRate) / fromRate);
  const out = new Float32Array(length);
  const last = samples.length - 1;
  const step = fromRate / toRate;
  for (let i = 0; i < length; i++) {
    const pos = i * step;
    const i0 = Math.min(Math.floor(pos), last);
    const i1 = Math.min(i0 + 1, last);
    const a = samples[i0] ?? 0;
    const b = samples[i1] ?? 0;
    out[i] = a + (b - a) * (pos - Math.floor(pos));
  }
  return out;
}

async function resample(samples: Float32Array, fromRate: number, toRate: number): Promise<Float32Array> {
  if (fromRate === toRate || samples.length === 0) return samples;
  const Offline = offlineAudioContextCtor();
  if (Offline) {
    try {
      // The engine's resampler low-pass filters; plain interpolation would alias sibilants into the band.
      const offline = new Offline(1, Math.max(1, Math.round((samples.length * toRate) / fromRate)), toRate);
      const buffer = offline.createBuffer(1, samples.length, fromRate);
      buffer.getChannelData(0).set(samples);
      const node = offline.createBufferSource();
      node.buffer = buffer;
      node.connect(offline.destination);
      node.start(0);
      return (await renderOffline(offline)).getChannelData(0);
    } catch {
      // Older engines refuse offline contexts below 22.05 kHz: fall through to interpolation.
    }
  }
  return resampleLinear(samples, fromRate, toRate);
}

/** Decodes any browser-recorded blob and re-encodes it as 16 kHz mono 16-bit PCM WAV. Throws if undecodable. */
export async function blobToWav16k(blob: Blob): Promise<Blob> {
  const Ctor = audioContextCtor();
  if (!Ctor) throw new Error('Cannot convert the recording: this environment has no AudioContext.');
  const bytes = await blob.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error('Cannot convert the recording: it is empty.');
  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch (err) {
    throw new Error(`Cannot convert the recording: ${errorText(err)}`);
  }
  let decoded: AudioBuffer;
  try {
    decoded = await decodeAudio(ctx, bytes);
  } catch (err) {
    throw new Error(`Cannot decode the recording (${blob.type || 'unknown type'}): ${errorText(err)}`);
  } finally {
    // Browsers cap live AudioContexts (iOS at a handful), so this one never outlives the decode.
    closeAudio(ctx);
  }
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  const samples = await resample(mixToMono(channels), decoded.sampleRate, WAV_SAMPLE_RATE);
  return new Blob([encodeWav(samples, WAV_SAMPLE_RATE)], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Pure WAV encoder (RIFF/WAVE, PCM 16-bit, mono, little-endian). Samples are clamped to [-1, 1]; NaN → 0. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError(`Invalid sample rate: ${sampleRate}`);
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size for PCM
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const raw = samples[i] ?? 0;
    const s = Number.isNaN(raw) ? 0 : Math.max(-1, Math.min(1, raw));
    // int16 is asymmetric: -1 maps to -32768 and +1 to 32767.
    view.setInt16(44 + i * bytesPerSample, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return buffer;
}
