// Renders the I2 "Receipt" pixel icon to PNG/SVG without any dependency (zlib is built in).
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

const C = { K: [0x0b, 0x0b, 0x0b], W: [0xff, 0xff, 0xff], O: [0xff, 0x4f, 0x00] };
const ROWS = [
  '................',
  '...WWWWWWWWWW...',
  '...WWWWWWWWWW...',
  '...WKKKKKWWWW...',
  '...WWWWWWWWWW...',
  '...WKKKWWWKKW...',
  '...WWWWWWWWWW...',
  '...WKKKKWWWKW...',
  '...WWWWWWWWWW...',
  '...WOOOOOOOOW...',
  '...WOOOOOOOOW...',
  '...WWWWWWWWWW...',
  '...WWWWWWWWWW...',
  '...WWWWWWWWWW...',
  '...W.W.W.W.W....',
  '................',
];

/** Returns the RGB for grid cell (x,y); '.' is the black background. */
function cell(x, y) {
  const ch = ROWS[y]?.[x] ?? '.';
  return ch === '.' ? C.K : C[ch];
}

// ---- PNG encoder (RGBA, 8-bit) ----
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function png(width, height, rgbaAt) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = rgbaAt(x, y);
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Edge-to-edge render: the 16×16 grid fills the whole square (nearest neighbour). */
function renderFull(size) {
  return png(size, size, (px, py) => {
    const x = Math.floor((px * 16) / size);
    const y = Math.floor((py * 16) / size);
    return [...cell(x, y), 255];
  });
}
/** Maskable render: the grid sits in a 20×20 black canvas so it stays inside the 80% safe zone. */
function renderMaskable(size) {
  return png(size, size, (px, py) => {
    const gx = Math.floor((px * 20) / size) - 2;
    const gy = Math.floor((py * 20) / size) - 2;
    const rgb = gx < 0 || gy < 0 || gx > 15 || gy > 15 ? C.K : cell(gx, gy);
    return [...rgb, 255];
  });
}
/** Monochrome badge for Android notifications: white receipt shape on transparent. */
function renderBadge(size) {
  return png(size, size, (px, py) => {
    const x = Math.floor((px * 16) / size);
    const y = Math.floor((py * 16) / size);
    const ch = ROWS[y]?.[x] ?? '.';
    return ch === '.' ? [0, 0, 0, 0] : [255, 255, 255, 255];
  });
}

function svg() {
  const rects = [];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const ch = ROWS[y][x];
      if (ch === '.' || ch === 'K') continue;
      const fill = ch === 'W' ? '#FFFFFF' : '#FF4F00';
      rects.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${fill}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" fill="#0B0B0B"/>${rects.join('')}</svg>\n`;
}

writeFileSync(join(out, 'icon.svg'), svg());
writeFileSync(join(out, 'icon-32.png'), renderFull(32));
writeFileSync(join(out, 'icon-192.png'), renderFull(192));
writeFileSync(join(out, 'icon-512.png'), renderFull(512));
writeFileSync(join(out, 'maskable-512.png'), renderMaskable(512));
writeFileSync(join(out, 'apple-touch-icon.png'), renderFull(180));
writeFileSync(join(out, 'badge-96.png'), renderBadge(96));
console.log('icons written to', out);
