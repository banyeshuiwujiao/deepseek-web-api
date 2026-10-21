/**
 * Real-environment verification for the attachment path: upload a generated image through the
 * reverse proxy and ask the model about it.
 *
 * The image is a solid colour with a large letter drawn in the middle, so a correct answer proves the
 * model actually saw the pixels rather than guessing from the prompt. The colour and letter are chosen
 * to be unambiguous (a pure, saturated colour plus one glyph).
 *
 * The test session is deleted immediately afterwards, exactly like the spike did.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const WIDTH = 64;
const HEIGHT = 64;

/** Solid magenta background with a white "Z" in the middle. */
const BACKGROUND = [220, 20, 140];
const FOREGROUND = [255, 255, 255];

function isOnZ(x, y) {
  // Three strokes of a blocky Z, each 12px thick inside a 64px canvas.
  const inTop = y >= 16 && y <= 27 && x >= 12 && x <= 51;
  const inDiagonal = Math.abs(y - (74 - x)) <= 6 && x >= 12 && x <= 51;
  const inBottom = y >= 36 && y <= 47 && x >= 12 && x <= 51;
  return inTop || inDiagonal || inBottom;
}

const raw = Buffer.alloc(HEIGHT * (WIDTH * 3 + 1));
for (let y = 0; y < HEIGHT; y += 1) {
  raw[y * (WIDTH * 3 + 1)] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = isOnZ(x, y) ? FOREGROUND : BACKGROUND;
    const offset = y * (WIDTH * 3 + 1) + 1 + x * 3;
    raw[offset] = r;
    raw[offset + 1] = g;
    raw[offset + 2] = b;
  }
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return crc ^ -1;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8;
ihdr[9] = 2;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const outPath = new URL("../data/verify-image.png", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
writeFileSync(outPath, png);
console.log(`# wrote ${outPath} (${png.length} bytes, ${WIDTH}x${HEIGHT}, magenta with a white Z)`);
console.log(`# data URL length (base64): ${png.toString("base64").length}`);
