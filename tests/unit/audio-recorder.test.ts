import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Recorder } from '@app/lib/audio';

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = [];
  static supported = new Set<string>();
  static probes: string[] = [];
  static isTypeSupported(type: string): boolean {
    FakeMediaRecorder.probes.push(type);
    return FakeMediaRecorder.supported.has(type);
  }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  timeslice: number | undefined;
  constructor(
    readonly stream: FakeStream,
    readonly options?: { mimeType?: string },
  ) {
    super();
    this.mimeType = options?.mimeType ?? 'audio/webm'; // the "browser default"
    FakeMediaRecorder.instances.push(this);
  }
  start(timeslice?: number): void {
    this.state = 'recording';
    this.timeslice = timeslice;
  }
  emit(bytes: number[]): void {
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) }));
  }
  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    // Like browsers: a last dataavailable, then stop, asynchronously.
    setTimeout(() => {
      this.emit([9, 9]);
      this.dispatchEvent(new Event('stop'));
    }, 0);
  }
}

class FakeAnalyser {
  fftSize = 2048;
  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }
  getByteFrequencyData(bins: Uint8Array): void {
    bins.fill(FakeAudioContext.level);
  }
}

class FakeSource {
  readonly targets: unknown[] = [];
  disconnected = false;
  connect(target: unknown): void {
    this.targets.push(target);
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static level = 128;
  state = 'running';
  readonly sampleRate = 48_000;
  closed = false;
  readonly sources: FakeSource[] = [];
  readonly analysers: FakeAnalyser[] = [];
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource(_stream: unknown): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async close(): Promise<void> {
    this.closed = true;
    this.state = 'closed';
  }
}

const frames = new Map<number, () => void>();
let nextFrame = 1;

function runFrame(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let stream: FakeStream;
let getUserMedia: ReturnType<typeof vi.fn<(constraints: MediaStreamConstraints) => Promise<FakeStream>>>;

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.probes = [];
  FakeMediaRecorder.supported = new Set(['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus']);
  FakeAudioContext.instances = [];
  FakeAudioContext.level = 128;
  frames.clear();
  stream = new FakeStream();
  getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) return err;
  }
  throw new Error('expected a rejection with an Error');
}

describe('Recorder', () => {
  it('records with the first supported type and a 250 ms timeslice, and stop() resolves the blob', async () => {
    FakeMediaRecorder.supported = new Set(['audio/mp4', 'audio/ogg;codecs=opus']);
    const recorder = new Recorder();
    expect(recorder.mimeType).toBe('');
    await recorder.start(() => undefined);

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(FakeMediaRecorder.probes.slice(0, 2)).toEqual(['audio/webm;codecs=opus', 'audio/mp4']);
    const media = FakeMediaRecorder.instances[0];
    expect(media?.options).toEqual({ mimeType: 'audio/mp4' });
    expect(media?.timeslice).toBe(250);
    expect(recorder.mimeType).toBe('audio/mp4');

    media?.emit([1, 2, 3]);
    media?.emit([]); // empty chunks are skipped
    media?.emit([4, 5]);
    const blob = await recorder.stop();
    expect(blob.type).toBe('audio/mp4');
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3, 4, 5, 9, 9]);
  });

  it('prefers webm/opus, and uses the browser default when nothing listed is supported', async () => {
    const first = new Recorder();
    await first.start(() => undefined);
    expect(FakeMediaRecorder.instances[0]?.options).toEqual({ mimeType: 'audio/webm;codecs=opus' });
    await first.stop();

    FakeMediaRecorder.supported = new Set();
    const second = new Recorder();
    await second.start(() => undefined);
    expect(FakeMediaRecorder.instances[1]?.options).toBeUndefined();
    expect(second.mimeType).toBe('audio/webm');
    expect((await second.stop()).type).toBe('audio/webm');
  });

  it('reports 46 levels in 0..1 on every animation frame until stopped', async () => {
    const levels: Float32Array[] = [];
    const recorder = new Recorder();
    await recorder.start((values) => levels.push(values));
    const audio = FakeAudioContext.instances[0];
    expect(audio?.analysers[0]?.fftSize).toBe(256);
    expect(audio?.sources[0]?.targets).toEqual([audio?.analysers[0]]);

    runFrame();
    FakeAudioContext.level = 255;
    runFrame();
    expect(levels).toHaveLength(2);
    expect(levels[0]).toBeInstanceOf(Float32Array);
    expect(levels[0]).toHaveLength(46);
    for (const value of levels[0] ?? []) expect(value).toBeCloseTo(128 / 255, 5);
    expect(Array.from(levels[1] ?? [])).toEqual(new Array(46).fill(1));

    await recorder.stop();
    expect(frames.size).toBe(0);
    runFrame();
    expect(levels).toHaveLength(2);
  });

  it('releases the microphone, the analyser and the audio context on stop', async () => {
    const recorder = new Recorder();
    await recorder.start(() => undefined);
    await recorder.stop();
    const audio = FakeAudioContext.instances[0];
    expect(stream.track.stopped).toBe(true);
    expect(audio?.sources[0]?.disconnected).toBe(true);
    expect(audio?.closed).toBe(true);
    await expect(recorder.stop()).rejects.toMatchObject({ name: 'InvalidStateError' });
  });

  it('can record again after stopping', async () => {
    const recorder = new Recorder();
    await recorder.start(() => undefined);
    await recorder.stop();
    stream = new FakeStream();
    await recorder.start(() => undefined);
    FakeMediaRecorder.instances[1]?.emit([7]);
    expect(Array.from(new Uint8Array(await (await recorder.stop()).arrayBuffer()))).toEqual([7, 9, 9]);
  });

  it('cancel() stops everything without producing a blob', async () => {
    const recorder = new Recorder();
    await recorder.start(() => undefined);
    recorder.cancel();
    expect(FakeMediaRecorder.instances[0]?.state).toBe('inactive');
    expect(stream.track.stopped).toBe(true);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
    expect(frames.size).toBe(0);
    await expect(recorder.stop()).rejects.toMatchObject({ name: 'InvalidStateError' });
    recorder.cancel(); // idempotent
  });

  it('cancel() rejects a pending stop() with AbortError', async () => {
    const recorder = new Recorder();
    await recorder.start(() => undefined);
    const stopping = recorder.stop();
    recorder.cancel();
    expect((await errorOf(stopping)).name).toBe('AbortError');
  });

  it('cancel() while permission is pending releases the stream once it arrives', async () => {
    const permission = deferred<FakeStream>();
    getUserMedia.mockImplementationOnce(() => permission.promise);
    const recorder = new Recorder();
    const starting = recorder.start(() => undefined);
    recorder.cancel();
    permission.resolve(stream);
    expect((await errorOf(starting)).name).toBe('AbortError');
    expect(stream.track.stopped).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });

  it('stop() right after start() waits for recording to begin, then stops', async () => {
    const permission = deferred<FakeStream>();
    getUserMedia.mockImplementationOnce(() => permission.promise);
    const recorder = new Recorder();
    const starting = recorder.start(() => undefined);
    const stopping = recorder.stop();
    permission.resolve(stream);
    await starting;
    const blob = await stopping;
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([9, 9]);
    expect(stream.track.stopped).toBe(true);
  });

  it.each(['NotAllowedError', 'NotFoundError'])('rethrows getUserMedia %s with its name', async (name) => {
    getUserMedia.mockImplementationOnce(async () => {
      throw new DOMException('denied', name);
    });
    const recorder = new Recorder();
    const err = await errorOf(recorder.start(() => undefined));
    expect(err.name).toBe(name);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
    await expect(recorder.stop()).rejects.toMatchObject({ name: 'InvalidStateError' });
  });

  it('reports NotSupportedError without getUserMedia or MediaRecorder', async () => {
    vi.stubGlobal('navigator', {});
    expect((await errorOf(new Recorder().start(() => undefined))).name).toBe('NotSupportedError');
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('MediaRecorder', undefined);
    expect((await errorOf(new Recorder().start(() => undefined))).name).toBe('NotSupportedError');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('refuses a second start() while recording', async () => {
    const recorder = new Recorder();
    await recorder.start(() => undefined);
    expect((await errorOf(recorder.start(() => undefined))).name).toBe('InvalidStateError');
    await recorder.stop();
  });

  it('still records when there is no AudioContext for the waveform', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const onLevel = vi.fn();
    const recorder = new Recorder();
    await recorder.start(onLevel);
    FakeMediaRecorder.instances[0]?.emit([1]);
    runFrame();
    expect(onLevel).not.toHaveBeenCalled();
    expect(Array.from(new Uint8Array(await (await recorder.stop()).arrayBuffer()))).toEqual([1, 9, 9]);
  });
});
