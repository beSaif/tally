/**
 * Stand-in for src/app/lib/audio.ts (visual-test dev server only, while the real module is a stub).
 * It does not touch the microphone: it reports the design page's waveform and returns a short
 * silent WAV, so the recording sheet can be screenshotted deterministically.
 */
export class Recorder {
  readonly mimeType: string = 'audio/wav';
  private frame = 0;
  private started = 0;

  async start(onLevel: (levels: Float32Array) => void): Promise<void> {
    this.started = performance.now();
    const tick = () => {
      const levels = new Float32Array(46);
      for (let i = 0; i < levels.length; i++) levels[i] = Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.23));
      onLevel(levels);
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  async stop(): Promise<Blob> {
    cancelAnimationFrame(this.frame);
    const seconds = Math.max(0.5, (performance.now() - this.started) / 1000);
    return new Blob([encodeWav(new Float32Array(Math.round(16000 * Math.min(seconds, 2))), 16000)], { type: 'audio/wav' });
  }

  cancel(): void {
    cancelAnimationFrame(this.frame);
  }
}

export async function blobToWav16k(blob: Blob): Promise<Blob> {
  return blob;
}

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return buffer;
}
