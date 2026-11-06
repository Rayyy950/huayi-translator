/**
 * Generates the extension icons with no external image dependencies.
 * Design: rounded blue tile with two white exchange arrows.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const OUT = path.resolve(import.meta.dirname, '..', 'public', 'icons');
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = clamp(x, x0 + r, x1 - r);
  const cy = clamp(y, y0 + r, y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function sign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function inTriangle(px, py, a, b, c) {
  const d1 = sign(px, py, a[0], a[1], b[0], b[1]);
  const d2 = sign(px, py, b[0], b[1], c[0], c[1]);
  const d3 = sign(px, py, c[0], c[1], a[0], a[1]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function renderHi(size) {
  const hi = size * SUPERSAMPLE;
  const buffer = Buffer.alloc(hi * hi * 4);
  const scale = hi / 128;
  const bars = [
    {
      x0: 30,
      y0: 48,
      x1: 82,
      y1: 61,
      head: [
        [82, 41],
        [105, 54.5],
        [82, 68],
      ],
    },
    {
      x0: 46,
      y0: 67,
      x1: 98,
      y1: 80,
      head: [
        [46, 60],
        [23, 73.5],
        [46, 87],
      ],
    },
  ];
  for (let py = 0; py < hi; py++) {
    for (let px = 0; px < hi; px++) {
      const x = (px + 0.5) / scale;
      const y = (py + 0.5) / scale;
      const index = (py * hi + px) * 4;
      if (!inRoundRect(x, y, 4, 4, 124, 124, 26)) continue;
      const t = clamp((y - 4) / 120, 0, 1);
      let r = Math.round(79 - (79 - 26) * t);
      let g = Math.round(140 - (140 - 74) * t);
      let b = Math.round(247 - (247 - 210) * t);
      let alpha = 255;
      let white = false;
      for (const bar of bars) {
        if (inRoundRect(x, y, bar.x0, bar.y0, bar.x1, bar.y1, 5)) white = true;
        if (inTriangle(x, y, bar.head[0], bar.head[1], bar.head[2])) white = true;
      }
      if (white) {
        r = 255;
        g = 255;
        b = 255;
      }
      buffer[index] = r;
      buffer[index + 1] = g;
      buffer[index + 2] = b;
      buffer[index + 3] = alpha;
    }
  }
  return { buffer, hi };
}

function downsample(hi, buffer, size) {
  const out = Buffer.alloc(size * size * 4);
  const factor = hi / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const index = ((y * factor + sy) * hi + (x * factor + sx)) * 4;
          const alpha = buffer[index + 3] / 255;
          r += buffer[index] * alpha;
          g += buffer[index + 1] * alpha;
          b += buffer[index + 2] * alpha;
          a += buffer[index + 3];
          count++;
        }
      }
      const outIndex = (y * size + x) * 4;
      const alphaAverage = a / count;
      const unpremultiply = alphaAverage > 0 ? 255 / alphaAverage : 0;
      out[outIndex] = Math.round(clamp((r / count) * unpremultiply, 0, 255));
      out[outIndex + 1] = Math.round(clamp((g / count) * unpremultiply, 0, 255));
      out[outIndex + 2] = Math.round(clamp((b / count) * unpremultiply, 0, 255));
      out[outIndex + 3] = Math.round(alphaAverage);
    }
  }
  return out;
}

await mkdir(OUT, { recursive: true });
for (const size of SIZES) {
  const { buffer, hi } = renderHi(size);
  const pixels = downsample(hi, buffer, size);
  await writeFile(path.join(OUT, `icon-${size}.png`), encodePng(size, size, pixels));
  console.log(`wrote public/icons/icon-${size}.png`);
}
