/**
 * Receipt photo preparation. Frozen interface, see docs/SPEC.md §7.3 / §7.6.
 * TODO(gemini-agent): implement.
 */
export async function downscaleToJpeg(_file: Blob, _maxSide: number, _quality: number): Promise<Blob> {
  throw new Error('not implemented');
}
