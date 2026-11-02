/**
 * Recording a voice note (src/app/lib/capture.ts, spec §3.4 and §13): it listens until "Stop & send"
 * or Cancel, through the permission prompt too. The browser's microphone and recorder are small
 * fakes, and the clock is a stub.
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

let now: number;
let stream: FakeStream;
let mic: ReturnType<typeof deferred<FakeStream>>;
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
  FakeMediaRecorder.instances = [];
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(() => mic.promise) } });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  recording?.closeCapture(); // stops the timers of a note still listening
  vi.unstubAllGlobals();
});

describe('a voice note', () => {
  it('listens until Stop & send, then sends', async () => {
    const { capture, finishRecording, startRecording } = await load();
    void startRecording();
    expect(capture.value).toEqual({ kind: 'recording', starting: true });
    mic.resolve(stream);
    await settle();
    expect(capture.value).toEqual({ kind: 'recording', starting: false });
    expect(micDevice()?.state).toBe('recording');

    now = 5000; // nothing ends it by itself before the 60 s cap
    await settle();
    expect(micDevice()?.state).toBe('recording');

    void finishRecording(true);
    await settle();
    // Sent: the recorder stopped, the microphone was released, and the note went to Gemini (no key here).
    expect(micDevice()?.state).toBe('inactive');
    expect(stream.track.stopped).toBe(true);
    expect(capture.value).toMatchObject({ kind: 'error', code: 'invalid_key', input: { mode: 'voice', durationMs: 5000 } });
  });

  it('Cancel drops it and lets go of the microphone', async () => {
    const { capture, finishRecording, startRecording } = await load();
    void startRecording();
    mic.resolve(stream);
    await settle();
    now = 2000;
    void finishRecording(false);
    await settle();
    expect(micDevice()?.state).toBe('inactive');
    expect(stream.track.stopped).toBe(true);
    expect(capture.value).toEqual({ kind: 'idle' });
  });

  it('keeps listening once the permission prompt is allowed', async () => {
    const { capture, startRecording } = await load();
    void startRecording();
    await settle();
    now = 3000; // "Allow" took a while
    mic.resolve(stream);
    await settle();
    expect(capture.value).toEqual({ kind: 'recording', starting: false });
    expect(micDevice()?.state).toBe('recording');
  });

  it('shows the microphone error after "Don\'t allow"', async () => {
    const { capture, startRecording } = await load();
    void startRecording();
    await settle();
    mic.reject(new DOMException('Permission denied', 'NotAllowedError'));
    await settle();
    expect(capture.value).toEqual({ kind: 'error', input: null, code: 'micDenied' });
  });

  it('cancelled while the prompt is up: nothing records once allowed', async () => {
    const { capture, finishRecording, startRecording } = await load();
    void startRecording();
    void finishRecording(false);
    mic.resolve(stream);
    await settle();
    expect(capture.value).toEqual({ kind: 'idle' });
    expect(stream.track.stopped).toBe(true);
  });
});
