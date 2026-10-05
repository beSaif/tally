/**
 * Microphone recording + WAV re-encoding. Frozen interface, see docs/SPEC.md §7.3 / §7.6.
 * TODO(gemini-agent): implement. The frontend builds against these signatures.
 */

/** Records with MediaRecorder and reports live levels (0..1 per bar) for the waveform. */
export class Recorder {
  readonly mimeType: string = '';
  async start(_onLevel: (levels: Float32Array) => void): Promise<void> {
    throw new Error('not implemented');
  }
  async stop(): Promise<Blob> {
    throw new Error('not implemented');
  }
  cancel(): void {}
}

/** Decodes any browser-recorded blob and re-encodes it as 16 kHz mono 16-bit PCM WAV. Throws if undecodable. */
export async function blobToWav16k(_blob: Blob): Promise<Blob> {
  throw new Error('not implemented');
}

/** Pure WAV encoder (RIFF/WAVE, PCM 16-bit, mono). */
export function encodeWav(_samples: Float32Array, _sampleRate: number): ArrayBuffer {
  throw new Error('not implemented');
}
