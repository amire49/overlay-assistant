// Writes build/icon.png (256x256): accent ring with a light center dot, matching the tray icon.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZE = 256;
const ACCENT = [0x7c, 0x8c, 0xff];
const BG = [0x16, 0x16, 0x1a];

function pixel(x, y) {
  const c = (SIZE - 1) / 2;
  const d = Math.hypot(x - c, y - c);
  // 1px anti-aliasing at each edge
  const cover = (inner, outer) => Math.max(0, Math.min(1, d - inner + 0.5, outer - d + 0.5));
  const bg = cover(-1, SIZE * 0.5);
  const ring = cover(SIZE * 0.3, SIZE * 0.42);
  const dot = cover(-1, SIZE * 0.14);
  const mix = (a, b, t) => Math.round(a + (b - a) * t);
  let rgb = BG;
  rgb = rgb.map((v, i) => mix(v, ACCENT[i], ring));
  rgb = rgb.map((v) => mix(v, 0xf4, dot));
  return [...rgb, Math.round(bg * 255)];
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    Buffer.from(pixel(x, y)).copy(raw, y * (SIZE * 4 + 1) + 1 + x * 4);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(__dirname, "..", "build", "icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
