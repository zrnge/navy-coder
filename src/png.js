'use strict';

// A minimal PNG codec and pixel differ, for /playthrough's visual regression
// check. Standard library only (zlib) - no image package, which is the point:
// Navy ships with no runtime dependencies. It reads exactly what Chrome's
// Page.captureScreenshot produces and what the differ writes back: 8-bit,
// truecolour (RGB) or truecolour-with-alpha (RGBA), non-interlaced. Anything
// else is refused with an error that says so rather than decoded wrongly.
//
// The comparison runs here, in Node, not inside the browser. In the page it
// would need a second tab (visible in a headed playthrough), be subject to the
// tested site's own content-security policy, and be untestable without Chrome.
// Here it is plain arithmetic the test suite can check directly.

const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Decode to { width, height, data }, data being RGBA at 4 bytes per pixel.
function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!width || !height) throw new Error('PNG has no IHDR chunk');
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`unsupported PNG (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}); `
      + 'only 8-bit RGB or RGBA, non-interlaced, is read');
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('PNG image data is truncated');
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    const prev = out - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? px[out + x - bpp] : 0;
      const b = y > 0 ? px[prev + x] : 0;
      const c = (x >= bpp && y > 0) ? px[prev + x - bpp] : 0;
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error('PNG uses an unknown row filter: ' + filter);
      }
      px[out + x] = r & 0xff;
    }
  }
  if (bpp === 4) return { width, height, data: new Uint8Array(px) };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    rgba[j] = px[i];
    rgba[j + 1] = px[i + 1];
    rgba[j + 2] = px[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, data: rgba };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

// Encode { width, height, data (RGBA) } as an 8-bit RGBA PNG. Every row uses
// filter 0: the images written here are diffs - mostly flat colour - which
// deflate well without the effort of choosing a filter per row.
function encodePng({ width, height, data }) {
  if (!data || data.length !== width * height * 4) {
    throw new Error('encodePng expects RGBA data of width * height * 4 bytes');
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: truecolour with alpha
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const src = Buffer.from(data.buffer, data.byteOffset, data.length);
  for (let y = 0; y < height; y++) {
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Compare two decoded images pixel by pixel. A pixel counts as changed when any
// channel moved by more than `tolerance`: anti-aliasing and font hinting shift
// edges by a few levels between otherwise identical renders, and counting those
// would make every comparison look like a change. Returns the counts, the box
// enclosing every change, and a diff image - the baseline washed out to a pale
// grey with the changed pixels in solid red - so a reader sees WHERE at a glance.
function diffImages(base, current, { tolerance = 32 } = {}) {
  if (base.width !== current.width || base.height !== current.height) {
    return {
      sizeMismatch: true,
      base: { width: base.width, height: base.height },
      current: { width: current.width, height: current.height },
    };
  }
  const { width, height } = base;
  const a = base.data;
  const b = current.data;
  const out = new Uint8Array(width * height * 4);
  let changed = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const d = Math.max(
        Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]),
        Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
      if (d > tolerance) {
        changed++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        out[i] = 255;
        out[i + 1] = 0;
        out[i + 2] = 0;
        out[i + 3] = 255;
      } else {
        const g = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
        const v = 200 + Math.round(g * 55 / 255);
        out[i] = v;
        out[i + 1] = v;
        out[i + 2] = v;
        out[i + 3] = 255;
      }
    }
  }
  const total = width * height;
  return {
    width,
    height,
    changed,
    total,
    ratio: changed / total,
    bbox: changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    diff: { width, height, data: out },
  };
}

module.exports = { decodePng, encodePng, diffImages, crc32 };
