/**
 * The mic press around the permission prompt (src/app/lib/capture.ts, spec §3.4 and §13). A prompt
 * takes the press with it, so a press that is going to prompt goes to tap mode at once; without a
 * Permissions API answer a slow start does the same; a pointercancel keeps listening. The browser's
 * microphone, recorder and Permissions API are small fakes, and the clock is a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  static isTypeSupported(): boolean {
    return true;
  }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  constructor(readonly stream: FakeStream) {
    super();
    FakeMediaRecorder.instances.push(this);
  }
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    // Like browsers: a last dataavailable, then stop, asynchronously.
    setTimeout(() => {
      this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) }));
      this.dispatchEvent(new Event('stop'));
    }, 0);
  }
}

class FakeAudioContext {
  state = 'running';
  readonly sampleRate = 48_000;
  createMediaStreamSource(): { connect(): void; disconnect(): void } {
    return { connect: () => undefined, disconnect: () => undefined };
  }
  createAnalyser(): { fftSize: number; frequencyBinCount: number; getByteFrequencyData(): void } {
    return { fftSize: 2048, frequencyBinCount: 128, getByteFrequencyData: () => undefined };
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
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

type Permission = 'granted' | 'prompt' | 'denied' | 'unsupported' | 'none';

let now: number;
let stream: FakeStream;
let mic: ReturnType<typeof deferred<FakeStream>>;
let permission: Permission;
let query: ReturnType<typeof vi.fn>;
type Capture = typeof import('@app/lib/capture');
let recording: Capture | undefined;

async function load(): Promise<Capture> {
  vi.resetModules();
  recording = await import('@app/lib/capture');
  return recording;
}

/** Lets promises and the fake recorder's stop settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const micDevice = () => FakeMediaRecorder.instances[0];

beforeEach(() => {
  now = 0;
  stream = new FakeStream();
  mic = deferred<FakeStream>();
  permission = 'granted';
  FakeMediaRecorder.instances = [];
  query = vi.fn(async (_descriptor: { name: string }) => {
    if (permission === 'unsupported') throw new TypeError("'microphone' is not a valid value for enumeration PermissionName.");
    return { state: permission };
  });
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(() => mic.promise) },
    get permissions() {
      return permission === 'none' ? undefined : { query };
    },
  });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  recording?.closeCapture(); // stops the timers of a note still listening
  vi.unstubAllGlobals();
});

describe('a press that is going to prompt', () => {
  it('goes to tap mode at once, and a late release changes nothing', async () => {
    permission = 'prompt';
    const { capture, releaseRecording, startRecording } = await load();
    void startRecording('pending');
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'pending', starting: true });
    await settle();
    expect(query).toHaveBeenCalledWith({ name: 'microphone' });
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'tap', starting: true });

    mic.resolve(stream); // "Allow"
    await settle();
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'tap', starting: false });
    expect(micDevice()?.state).toBe('recording');

    releaseRecording(2500); // should a pointerup still arrive
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'tap' });
    expect(micDevice()?.state).toBe('recording');
  });

  it('shows the microphone error after "Don\'t allow"', async () => {
    permission = 'prompt';
    const { capture, startRecording } = await load();
    void startRecording('pending');
    await settle();
    mic.reject(new DOMException('Permission denied', 'NotAllowedError'));
    await settle();
    expect(capture.value).toEqual({ kind: 'error', input: null, code: 'micDenied' });
  });

  it('is treated the same when the choice was denied for good', async () => {
    permission = 'denied';
    const { capture, startRecording } = await load();
    void startRecording('pending');
    await settle();
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'tap' });
  });
});

describe('with the microphone already granted', () => {
  it('a hold sends on release', async () => {
    const { capture, startRecording, releaseRecording } = await load();
    void startRecording('pending');
    mic.resolve(stream);
    await settle();
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'pending', starting: false });

    now = 1200;
    releaseRecording(1200);
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'hold' });
    await settle();
    // Sent: the recorder stopped, the microphone was released, and the note went to Gemini (no key here).
    expect(micDevice()?.state).toBe('inactive');
    expect(stream.track.stopped).toBe(true);
    expect(capture.value).toMatchObject({ kind: 'error', code: 'invalid_key', input: { mode: 'voice', durationMs: 1200 } });
  });

  it('a quick press keeps listening until tapped again', async () => {
    const { capture, startRecording, releaseRecording } = await load();
    void startRecording('pending');
    mic.resolve(stream);
    await settle();
    now = 100;
    releaseRecording(100);
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'tap' });
    expect(micDevice()?.state).toBe('recording');
  });

  it('a release while the microphone is still starting keeps listening', async () => {
    const { capture, startRecording, releaseRecording } = await load();
    void startRecording('pending');
    await settle();
    now = 800;
    releaseRecording(800);
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'tap', starting: true });
    mic.resolve(stream);
    await settle();
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'tap', starting: false });
    expect(micDevice()?.state).toBe('recording');
  });

  it('a slow start still waits for the release: the API said no prompt would come', async () => {
    const { capture, startRecording } = await load();
    void startRecording('pending');
    await settle();
    now = 1500;
    mic.resolve(stream);
    await settle();
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'pending', starting: false });
  });
});

describe('a pointercancel (the system took the touch)', () => {
  it('keeps listening in tap mode instead of discarding the note', async () => {
    const { capture, keepListening, startRecording } = await load();
    void startRecording('pending');
    mic.resolve(stream);
    await settle();
    keepListening();
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'tap' });
    expect(micDevice()?.state).toBe('recording');
    expect(stream.track.stopped).toBe(false);
  });

  it('while the prompt is still up: the note records once allowed', async () => {
    permission = 'none';
    const { capture, keepListening, startRecording } = await load();
    void startRecording('pending');
    keepListening();
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'tap', starting: true });
    mic.resolve(stream);
    await settle();
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'tap', starting: false });
    expect(micDevice()?.state).toBe('recording');
  });
});

describe('without a Permissions API answer', () => {
  it.each(['none', 'unsupported'] as const)('(%s) a start slower than a second with the press undecided goes to tap mode', async (api) => {
    permission = api;
    const { capture, startRecording } = await load();
    void startRecording('pending');
    await settle();
    expect(capture.value).toMatchObject({ gesture: 'pending', starting: true });
    now = 1500;
    mic.resolve(stream);
    await settle();
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'tap', starting: false });
  });

  it('a fast start leaves the hold/tap decision to the release', async () => {
    permission = 'none';
    const { capture, startRecording, releaseRecording } = await load();
    void startRecording('pending');
    now = 300;
    mic.resolve(stream);
    await settle();
    expect(capture.value).toMatchObject({ gesture: 'pending', starting: false });
    now = 1000;
    releaseRecording(1000);
    expect(capture.value).toMatchObject({ gesture: 'hold' });
  });

  it('a start in tap mode (Try again) never asks the API', async () => {
    const { capture, startRecording } = await load();
    void startRecording('tap');
    mic.resolve(stream);
    await settle();
    expect(query).not.toHaveBeenCalled();
    expect(capture.value).toMatchObject({ kind: 'recording', gesture: 'tap', starting: false });
  });
});
