// Draws the app icons: zencode's pink-to-violet gradient with a ">_"
// prompt. Run with `node scripts/icons.mjs`; output goes to public/icons.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const PINK = [255, 121, 176];
const VIOLET = [130, 120, 255];
const INK = [22, 18, 32];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// The glyph in unit coordinates (0..1), scaled by `inset` around the center.
const SEGMENTS = [
  [0.28, 0.32, 0.47, 0.5],
  [0.47, 0.5, 0.28, 0.68],
  [0.55, 0.7, 0.74, 0.7],
];

function icon(size, inset) {
  const sw = 0.075;
  return png(size, (x, y) => {
    const u = x / size, v = y / size;
    const t = (u + v) / 2;
    const bg = PINK.map((c, i) => Math.round(c + (VIOLET[i] - c) * t));
    const gu = 0.5 + (u - 0.5) / inset, gv = 0.5 + (v - 0.5) / inset;
    const d = Math.min(...SEGMENTS.map((s) => segDist(gu, gv, ...s)));
    // Antialias over about one pixel.
    const px = 1 / (size * inset);
    const a = Math.max(0, Math.min(1, (sw / 2 - d) / px + 0.5));
    return [...bg.map((c, i) => Math.round(c + (INK[i] - c) * a)), 255];
  });
}

writeFileSync("public/icons/icon-192.png", icon(192, 1));
writeFileSync("public/icons/icon-512.png", icon(512, 1));
writeFileSync("public/icons/icon-maskable-512.png", icon(512, 0.72));
writeFileSync("public/icons/apple-touch-icon.png", icon(180, 0.9));
writeFileSync(
  "public/icon.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff79b0"/><stop offset="1" stop-color="#8278ff"/></linearGradient></defs><rect width="100" height="100" rx="18" fill="url(#g)"/><path d="M28 32 47 50 28 68M55 70h19" fill="none" stroke="#161220" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`,
);
console.log("icons written");
