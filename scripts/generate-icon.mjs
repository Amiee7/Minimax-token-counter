// scripts/generate-icon.mjs
//
// Generates assets/icon.png (256×256) and assets/icon.ico (multi-resolution)
// using only Node built-ins (zlib, fs). No external image libraries.
//
// Run once after cloning:
//   node scripts/generate-icon.mjs
//
// The visual: dark navy background, teal→blue gradient circle in the
// center, white stylized "M" with a violet accent dot.

import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(__dirname, "..", "assets");
mkdirSync(assetsDir, { recursive: true });

const SIZE = 256;

// --- pixel rendering --------------------------------------------------------

function makePixels(size) {
  const buf = Buffer.alloc(size * size * 4); // RGBA
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const circleR = size * 0.42;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      // Background: dark navy
      let r = 14, g = 26, b = 43, a = 255;

      // Distance from center, scaled to [-1, 1]
      const dx = (x - cx) / circleR;
      const dy = (y - cy) / circleR;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= 1) {
        // Gradient: teal (#5ee0c0) → blue (#69b8ff) along the +x axis
        const t = (dx + 1) / 2; // 0..1
        const teal = { r: 94,  g: 224, b: 192 };
        const blue = { r: 105, g: 184, b: 255 };
        r = Math.round(teal.r + (blue.r - teal.r) * t);
        g = Math.round(teal.g + (blue.g - teal.g) * t);
        b = Math.round(teal.b + (blue.b - teal.b) * t);
        a = 255;
      }

      // Stylized "M": two outer diagonals + a small violet dot in the upper-right
      // outer-diagonal mask
      const mThickness = size * 0.085;
      const mLeft   = isOnLine(x, y, cx - size * 0.20, cy + size * 0.20, cx - size * 0.20, cy - size * 0.22, mThickness);
      const mRight  = isOnLine(x, y, cx + size * 0.20, cy + size * 0.20, cx + size * 0.20, cy - size * 0.22, mThickness);
      const mLeftUp  = isOnLine(x, y, cx - size * 0.20, cy - size * 0.22, cx,                cy + size * 0.06, mThickness);
      const mRightUp = isOnLine(x, y, cx + size * 0.20, cy - size * 0.22, cx,                cy + size * 0.06, mThickness);

      if (mLeft || mRight || mLeftUp || mRightUp) {
        r = 12; g = 26; b = 44; a = 255;
      }

      // violet dot at upper-right of the circle
      const dotX = cx + size * 0.22;
      const dotY = cy - size * 0.22;
      const dotDist = Math.sqrt((x - dotX) ** 2 + (y - dotY) ** 2);
      if (dotDist <= size * 0.045) {
        r = 199; g = 168; b = 255;
      }

      buf[i + 0] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  return buf;
}

function isOnLine(px, py, x1, y1, x2, y2, thickness) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return false;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  const dist = Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
  return dist <= thickness / 2;
}

// --- PNG encoder (truecolor RGBA, no palette) --------------------------------

function crc32(buf) {
  // Standard CRC-32 (polynomial 0xedb88320) — table-free, slow-but-clear.
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(pixels, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;   // bit depth
  ihdr[9]  = 6;   // color type = RGBA
  ihdr[10] = 0;   // compression: deflate
  ihdr[11] = 0;   // filter: standard
  ihdr[12] = 0;   // interlace: none

  // raw scanlines: filter byte 0 + RGBA pixels per row
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (rowBytes + 1)] = 0;
    pixels.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// --- ICO encoder (wraps one or more PNG payloads) ---------------------------

function encodeIco(pngs) {
  // ICONDIR (6 bytes) + N × ICONDIRENTRY (16 bytes) + N × image bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);  // reserved
  header.writeUInt16LE(1, 2);  // type = 1 (icon)
  header.writeUInt16LE(pngs.length, 4);

  const entries = Buffer.alloc(16 * pngs.length);
  let offset = 6 + 16 * pngs.length;
  for (let i = 0; i < pngs.length; i += 1) {
    const { size, data } = pngs[i];
    const off = i * 16;
    // width / height: 0 means 256 (8-bit field)
    entries[off + 0] = size >= 256 ? 0 : size;
    entries[off + 1] = size >= 256 ? 0 : size;
    entries[off + 2] = 0; // colors in palette
    entries[off + 3] = 0; // reserved
    entries.writeUInt16LE(1, off + 4);   // color planes
    entries.writeUInt16LE(32, off + 6);  // bits per pixel
    entries.writeUInt32LE(data.length, off + 8);  // size of image data
    entries.writeUInt32LE(offset, off + 12);       // offset
    offset += data.length;
  }

  return Buffer.concat([header, entries, ...pngs.map((p) => p.data)]);
}

// --- main --------------------------------------------------------------------

const pixels256 = makePixels(SIZE);
const png256 = encodePng(pixels256, SIZE, SIZE);

const pngPath = path.join(assetsDir, "icon.png");
writeFileSync(pngPath, png256);
console.log(`✓ ${pngPath} (${png256.length} bytes, ${SIZE}×${SIZE})`);

// Smaller icons for the multi-resolution ICO
const icoSizes = [16, 32, 48, 64, 128, 256];
const icoPngs = icoSizes.map((s) => ({
  size: s,
  data: encodePng(makePixels(s), s, s)
}));

const icoPath = path.join(assetsDir, "icon.ico");
writeFileSync(icoPath, encodeIco(icoPngs));
console.log(`✓ ${icoPath} (${icoPngs.length} sizes: ${icoSizes.join(", ")})`);