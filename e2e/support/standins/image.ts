/** Stand-in for src/app/lib/image.ts (visual-test dev server only): passes the picture through. */
export async function downscaleToJpeg(file: Blob, _maxSide: number, _quality: number): Promise<Blob> {
  return file;
}
