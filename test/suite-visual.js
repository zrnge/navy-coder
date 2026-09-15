const { check } = require('./harness.js');
const zlib = require('zlib');
const { decodePng, encodePng, diffImages, crc32 } = require('../src/png.js');

// The PNG codec and pixel differ behind /playthrough's visual regression check.
// Standard library only, so every part of it is checked here without a browser.

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

// Build a PNG by hand with ONE filter type on every row. The forward filters
// here are written independently of the decoder, so each inverse in the decoder
// is checked against something other than itself. colourType 6 = RGBA, 2 = RGB.
function handmadePng(width, height, pixels, filterType, colourType = 6, bitDepth = 8) {
  const bpp = colourType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filterType;
    for (let x = 0; x < stride; x++) {
      const cur = pixels[y * stride + x];
      const a = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? pixels[(y - 1) * stride + x - bpp] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filterType];
      raw[y * (stride + 1) + 1 + x] = (cur - pred) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colourType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Deterministic, busy pixel data: every channel differs from its neighbours, so
// all five filters actually have work to do.
function busyPixels(width, height, bpp) {
  const px = new Uint8Array(width * height * bpp);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37 + (i >> 3) * 11) & 0xff;
  return px;
}

function solid(width, height, rgba) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
}

async function pngSuite() {
  console.log('');
  console.log('visual regression: PNG codec and pixel diff (src/png.js):');

  check('png: CRC-32 matches the value every PNG\'s IEND chunk carries',
    crc32(Buffer.from('IEND', 'latin1')) === 0xae426082, crc32(Buffer.from('IEND', 'latin1')).toString(16));

  // Round trip through our own encoder.
  const src = { width: 7, height: 5, data: busyPixels(7, 5, 4) };
  const back = decodePng(encodePng(src));
  check('png: encode then decode round-trips exactly',
    back.width === 7 && back.height === 5 && Buffer.from(back.data).equals(Buffer.from(src.data)));

  // Every row filter, decoded against an independent forward filter.
  for (let f = 0; f <= 4; f++) {
    const px = busyPixels(9, 6, 4);
    const img = decodePng(handmadePng(9, 6, px, f));
    check(`png: row filter ${f} (${['None', 'Sub', 'Up', 'Average', 'Paeth'][f]}) decodes exactly`,
      Buffer.from(img.data).equals(Buffer.from(px)));
  }

  // RGB (no alpha) comes back as RGBA, opaque.
  const rgb = busyPixels(4, 3, 3);
  const fromRgb = decodePng(handmadePng(4, 3, rgb, 4, 2));
  let rgbOk = fromRgb.data.length === 4 * 3 * 4;
  for (let i = 0, j = 0; rgbOk && i < rgb.length; i += 3, j += 4) {
    rgbOk = fromRgb.data[j] === rgb[i] && fromRgb.data[j + 1] === rgb[i + 1]
      && fromRgb.data[j + 2] === rgb[i + 2] && fromRgb.data[j + 3] === 255;
  }
  check('png: an RGB image is expanded to opaque RGBA', rgbOk);

  let e1 = '';
  try { decodePng(Buffer.from('definitely not a png')); } catch (e) { e1 = e.message; }
  check('png: a non-PNG is refused, not misread', /not a PNG/.test(e1), e1);
  let e2 = '';
  try { decodePng(handmadePng(2, 2, new Uint8Array(2 * 2 * 4 * 2), 0, 6, 16)); } catch (e) { e2 = e.message; }
  check('png: a format it cannot read says which, instead of decoding it wrongly', /unsupported PNG.*bit depth 16/.test(e2), e2);

  // The differ.
  const white = solid(20, 10, [255, 255, 255, 255]);
  const same = diffImages(white, solid(20, 10, [255, 255, 255, 255]));
  check('diff: identical images have nothing changed and no box', same.changed === 0 && same.bbox === null && same.ratio === 0);

  const changedImg = solid(20, 10, [255, 255, 255, 255]);
  for (let y = 4; y < 6; y++) {
    for (let x = 3; x < 6; x++) changedImg.data.set([10, 20, 200, 255], (y * 20 + x) * 4);
  }
  const d = diffImages(white, changedImg);
  check('diff: a changed block is counted exactly', d.changed === 6 && Math.abs(d.ratio - 6 / 200) < 1e-12, String(d.changed));
  check('diff: ...and boxed exactly', JSON.stringify(d.bbox) === JSON.stringify({ x: 3, y: 4, width: 3, height: 2 }), JSON.stringify(d.bbox));
  const at = (img, x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
  check('diff: changed pixels are solid red in the diff image', JSON.stringify(at(d.diff, 4, 5)) === '[255,0,0,255]');
  const pale = at(d.diff, 0, 0);
  check('diff: unchanged pixels are washed out to a pale grey', pale[0] === pale[1] && pale[1] === pale[2] && pale[0] >= 200);

  const faint = solid(20, 10, [245, 245, 245, 255]);
  check('diff: a shift within tolerance (anti-aliasing, hinting) is not a change', diffImages(white, faint).changed === 0);
  check('diff: ...but the tolerance is a setting, not a blind spot', diffImages(white, faint, { tolerance: 5 }).changed === 200);

  const mismatch = diffImages(white, solid(20, 12, [255, 255, 255, 255]));
  check('diff: different sizes are reported as such rather than compared',
    mismatch.sizeMismatch === true && mismatch.current.height === 12);

  // A diff image survives being encoded for the model.
  const reread = decodePng(encodePng(d.diff));
  check('diff: the diff image encodes as a valid PNG', reread.width === 20 && JSON.stringify(at(reread, 4, 5)) === '[255,0,0,255]');
}

module.exports = { pngSuite };
