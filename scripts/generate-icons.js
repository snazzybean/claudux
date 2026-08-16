// Generates the PWA home-screen icons - no image library, just Node
// built-ins: the PNG is assembled by hand, `zlib` takes care of the
// DEFLATE compression of the IDAT data.
//
// Motif: background field in the manifest color with a light, contrasting
// "C" monogram, computed geometrically from distance and angle.
//
// Run: node scripts/generate-icons.js
// Creates/overwrites: public/icons/icon-192.png, public/icons/icon-512.png

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '../public/icons');

const BG = [0x12, 0x15, 0x1b]; // background_color / theme_color from manifest.json
const FG = [0xf5, 0xf7, 0xfa]; // light, contrasting monogram

/** CRC32 implementation per the PNG standard (Annex D of the PNG spec). */
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = makeCrcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Returns true if pixel (x, y) should be part of the "C" ring: distance
 * from the center lies between the inner and outer radius, AND the angle
 * doesn't fall in the C's right-side "opening" sector.
 */
function isMonogramPixel(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size * 0.36;
  const rInner = size * 0.22;
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < rInner || dist > rOuter) return false;
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, 0 = right
  const gapHalfWidth = 38; // degrees
  if (angleDeg > -gapHalfWidth && angleDeg < gapHalfWidth) return false; // opening faces right
  return true;
}

function buildPng(size) {
  const rowBytes = size * 4; // RGBA
  const raw = Buffer.alloc((rowBytes + 1) * size); // +1 filter byte per row

  for (let y = 0; y < size; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // filter type 0 (None) for every row
    for (let x = 0; x < size; x++) {
      const isFg = isMonogramPixel(x, y, size);
      const [r, g, b] = isFg ? FG : BG;
      const px = rowStart + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = 0xff; // fully opaque
    }
  }

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0); // Width
  ihdrData.writeUInt32BE(size, 4); // Height
  ihdrData[8] = 8; // Bit depth
  ihdrData[9] = 6; // Color type: 6 = RGBA (truecolor with alpha)
  ihdrData[10] = 0; // Compression method
  ihdrData[11] = 0; // Filter method
  ihdrData[12] = 0; // Interlace method

  const idatData = deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdrData),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const png = buildPng(size);
  const outPath = path.join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(outPath, png);
  console.log(`written: ${outPath} (${png.length} bytes)`);
}
